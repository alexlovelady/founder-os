import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { call, FakeAi, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { deps, tool } from "../src/index";
import { makeNet, PUBLIC_IP, redirect, type Route } from "./net-fake";

const ORIGINAL = { net: deps.net, fetch: deps.fetch, hourlyLimit: deps.hourlyLimit, cooldownMs: deps.cooldownMs };

const state = { pricing: "Starter $29 per month", version: 1 };
const rivalSite = (u: URL, host = "rival.io"): Route | undefined => {
  if (u.hostname !== host && u.hostname !== `www.${host}`) return undefined;
  switch (u.pathname) {
    case "/robots.txt": return { type: "text/plain", body: "User-agent: *\nDisallow: /secret\n" };
    case "/": return { body: `<html><head><title>Rival</title></head><body><nav><a href="/pricing">Pricing</a><a href="/secret">About</a></nav><h1>Scheduling for salons v${state.version}</h1></body></html>` };
    case "/pricing": return { body: `<html><title>Pricing</title><body><p>${state.pricing}</p></body></html>` };
    case "/extra": return { body: "<html><body>Extra page text</body></html>" };
    default: return undefined;
  }
};

const ANALYSIS = JSON.stringify({
  positioning: [{ claim: "Scheduling software for salons", source_url: "https://rival.io/", quote: "Scheduling for salons" }],
  pricing: [{ claim: "Starter plan is $29 a month", source_url: "https://rival.io/pricing", quote: "Starter $29 per month" }, { claim: "Pro is $99", source_url: "https://rival.io/pricing", quote: "Pro $99" }],
  strengths: [{ claim: "Simple", source_url: "https://rival.io/" }],
  comparison_with_us: "Opinion: they focus on salons only.",
});

describe("competitors tool (database)", () => {
  let env: TestEnv;
  let ai: FakeAi;
  let id = "";

  beforeAll(async () => {
    // AI call order used below: 1 discovery (no search key), 2 analysis, 3 report.
    ai = new FakeAi(["- Rival Scheduler - popular with salons\n- Trim Pro: barber booking\nHere are some:", ANALYSIS, "SUMMARY: A small market of scheduling tools.\n## Comparison matrix\n| a | b |"]);
    env = await makeTestEnv([tool], { ai, facts: { product: { handlesPayments: true, stack: ["Next.js"] } } });
    deps.cooldownMs = 0;
    delete process.env.SEARCH_API_KEY;
  });
  afterAll(async () => {
    Object.assign(deps, ORIGINAL);
    await env.cleanup();
  });
  afterEach(() => {
    deps.cooldownMs = 0;
    deps.hourlyLimit = 120;
  });

  it("validates input and refuses obviously private addresses up front", async () => {
    expect((await call(tool, env.ctx, "POST", "competitors", {})).status).toBe(400);
    for (const url of ["https://127.0.0.1/", "http://localhost/", "https://169.254.169.254/", "ftp://x.com", "https://[::1]/", "https://intranet/", "https://user:pw@rival.io/"]) {
      expect((await call(tool, env.ctx, "POST", "competitors", { name: "Bad", url })).status).toBe(400);
    }
  });

  it("adds a competitor (http becomes https, bare domains work) and rejects duplicates", async () => {
    const r = await call(tool, env.ctx, "POST", "competitors", { name: "Rival", url: "http://rival.io", notes: "main rival" });
    expect(r.status).toBe(201);
    expect(r.data.competitor).toMatchObject({ name: "Rival", url: "https://rival.io/", status: "new" });
    id = r.data.competitor.id;
    expect((await call(tool, env.ctx, "POST", "competitors", { name: "Dup", url: "rival.io/" })).status).toBe(409);
    expect((await call(tool, env.ctx, "POST", "competitors", { name: "Bare", url: "bare-rival.com/home/", source: "ai_suggestion" })).data.competitor).toMatchObject({ url: "https://bare-rival.com/home", source: "ai_suggestion" });
  });

  it("suggests names with the AI and labels them as unverified (no search key set)", async () => {
    const start = await call(tool, env.ctx, "POST", "discover", {});
    expect(start.status).toBe(202);
    expect(start.data.source).toBe("ai");
    expect(ai.calls[0].prompt).toContain("Test Co A");
    const done = await call(tool, env.ctx, "GET", `discover/${start.data.discoveryId}`);
    expect(done.data.state).toBe("done");
    expect(done.data.label).toMatch(/Unverified suggestion, check the website/);
    expect(done.data.suggestions).toEqual([{ name: "Rival Scheduler", note: "popular with salons" }, { name: "Trim Pro", note: "barber booking" }]);
    expect(done.data.suggestions[0]).not.toHaveProperty("url");
  });

  it("fetches pages safely, honouring robots.txt and telling the user what was skipped", async () => {
    const net = makeNet((u) => rivalSite(u));
    deps.net = net.net;
    const r = await call(tool, env.ctx, "POST", `competitors/${id}/fetch`);
    expect(r.status).toBe(200);
    expect(r.data.competitor).toMatchObject({ status: "fetched" });
    const paths = r.data.pages.map((p: { url: string; status: string }) => [new URL(p.url).pathname, p.status]);
    expect(paths).toEqual(expect.arrayContaining([["/", "ok"], ["/pricing", "ok"], ["/secret", "blocked_robots"]]));
    expect(r.data.skipped[0].reason).toMatch(/robots\.txt/);
    expect(net.calls.some((c) => c.path === "/secret")).toBe(false);
    expect(net.calls.every((c) => c.headers["user-agent"].startsWith("FounderOS-Research/1.0") && c.address === PUBLIC_IP)).toBe(true);
    expect(r.data.changed).toEqual([]);
  });

  it("re-fetching detects what changed using content hashes", async () => {
    state.pricing = "Starter $39 per month";
    deps.net = makeNet((u) => rivalSite(u)).net;
    const r = await call(tool, env.ctx, "POST", `competitors/${id}/fetch`);
    expect(r.data.changed).toEqual(["https://rival.io/pricing"]);
    const detail = await call(tool, env.ctx, "GET", `competitors/${id}`);
    const pricing = detail.data.pages.find((p: { url: string }) => p.url.endsWith("/pricing"));
    expect(pricing).toMatchObject({ changed: true, status: "ok" });
    expect(pricing.excerpt).toContain("$39");
    // a third fetch with identical content clears the flag
    deps.net = makeNet((u) => rivalSite(u)).net;
    const again = await call(tool, env.ctx, "POST", `competitors/${id}/fetch`);
    expect(again.data.changed).toEqual([]);
    state.pricing = "Starter $29 per month";
  });

  it("lets the user add pages on the same site only", async () => {
    expect((await call(tool, env.ctx, "POST", `competitors/${id}/pages`, { url: "https://evil.com/x" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", `competitors/${id}/pages`, { url: "https://169.254.169.254/" })).status).toBe(400);
    const ok = await call(tool, env.ctx, "POST", `competitors/${id}/pages`, { url: "https://www.rival.io/extra" });
    expect(ok.status).toBe(201);
    const net = makeNet((u) => rivalSite(u));
    deps.net = net.net;
    await call(tool, env.ctx, "POST", `competitors/${id}/fetch`);
    expect(net.calls.some((c) => c.path === "/extra")).toBe(true);
    const detail = await call(tool, env.ctx, "GET", `competitors/${id}`);
    const extra = detail.data.pages.find((p: { url: string }) => p.url.endsWith("/extra"));
    expect(extra).toMatchObject({ userAdded: true, status: "ok" });
    expect((await call(tool, env.ctx, "DELETE", `competitors/${id}/pages/${extra.id}`)).status).toBe(200);
  });

  it("rate limits research per business and spaces out re-checks of one competitor", async () => {
    deps.net = makeNet((u) => rivalSite(u)).net;
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM competitors_fetch_log WHERE business_id = ${env.ctx.businessId}`;
    expect(n).toBeGreaterThan(0); // every outbound request (robots.txt included) is counted
    deps.hourlyLimit = n + 7; // not enough room for another run (needs 8)
    const limited = await call(tool, env.ctx, "POST", `competitors/${id}/fetch`);
    expect(limited.status).toBe(429);
    expect(limited.data.error).toMatch(/limit/i);
    // another business has its own budget, under the very same limit
    const o = await call(tool, env.other, "POST", "competitors", { name: "Rival", url: "https://rival.io" });
    expect((await call(tool, env.other, "POST", `competitors/${o.data.competitor.id}/fetch`)).status).toBe(200);
    deps.hourlyLimit = 120;
    deps.cooldownMs = 60_000;
    expect((await call(tool, env.ctx, "POST", `competitors/${id}/fetch`)).status).toBe(429);
  });

  it("surfaces unreachable and blocked sites instead of inventing content", async () => {
    const bad = await call(tool, env.ctx, "POST", "competitors", { name: "Ghost", url: "https://ghost.example.org" });
    deps.net = makeNet(() => undefined, { "ghost.example.org": ["10.1.1.1"] }).net;
    const r = await call(tool, env.ctx, "POST", `competitors/${bad.data.competitor.id}/fetch`);
    expect(r.status).toBe(200);
    expect(r.data.competitor).toMatchObject({ status: "error" });
    expect(r.data.competitor.lastError).toMatch(/private or internal/);
    expect((await call(tool, env.ctx, "POST", `competitors/${bad.data.competitor.id}/analyze`)).status).toBe(409);
    const redir = await call(tool, env.ctx, "POST", "competitors", { name: "Sneaky", url: "https://sneaky.example.org" });
    deps.net = makeNet((u) => (u.pathname === "/robots.txt" ? { status: 404 } : redirect("https://169.254.169.254/latest/meta-data/"))).net;
    const s = await call(tool, env.ctx, "POST", `competitors/${redir.data.competitor.id}/fetch`);
    expect(s.data.competitor.status).toBe("error");
    expect(s.data.pages[0].error).toMatch(/private or internal/);
  });

  it("runs the analysis as an AI job grounded in fetched text and business context, and keeps only sourced claims", async () => {
    deps.net = makeNet((u) => rivalSite(u)).net;
    const start = await call(tool, env.ctx, "POST", `competitors/${id}/analyze`);
    expect(start.status).toBe(202);
    const prompt = ai.calls[1].prompt;
    expect(prompt).toContain("Test Co A");
    expect(prompt).toContain("Scheduling for salons");
    expect(prompt).toContain("source_url=https://rival.io/pricing");
    expect(prompt).toContain("handlesPayments"); // product facts via ctx.facts()
    expect(prompt).toMatch(/robots\.txt/); // the skipped page is reported as not read
    expect(prompt).not.toContain("Extra page text"); // removed page
    const polled = await call(tool, env.ctx, "GET", `competitors/${id}/analyses/${start.data.analysisId}`);
    const a = polled.data.analysis;
    expect(a.state).toBe("done");
    expect(a.parsed).toBe(true);
    const claims = a.claims as { field: string; text: string; source_url: string | null; fetched_at: string | null; quote_verified: boolean | null }[];
    expect(claims.find((c) => c.field === "positioning")).toMatchObject({ source_url: "https://rival.io/", quote_verified: true });
    expect(claims.find((c) => c.field === "positioning")!.fetched_at).toMatch(/^20\d\d-/);
    expect(claims.filter((c) => c.field === "pricing").map((c) => c.text)).toEqual(["Starter plan is $29 a month"]);
    expect(a.rejected.map((r: { text: string }) => r.text)).toEqual(["Pro is $99"]);
    expect(claims.find((c) => c.field === "strengths")!.source_url).toBe("https://rival.io/");
    expect(a.comparison).toMatch(/Opinion/);
    expect(JSON.stringify(a)).not.toContain("Scheduling for salons v1</h1>");
    expect(a.sources.every((s: Record<string, unknown>) => !("text" in s))).toBe(true);
  });

  it("writes a cross-competitor report from stored, sourced claims only", async () => {
    const start = await call(tool, env.ctx, "POST", "report");
    expect(start.status).toBe(202);
    const prompt = ai.calls[2].prompt;
    expect(prompt).toContain("Rival");
    expect(prompt).toContain("source: https://rival.io/pricing");
    expect(prompt).not.toContain("Pro is $99"); // rejected claim never reaches the report
    const r = await call(tool, env.ctx, "GET", `reports/${start.data.reportId}`);
    expect(r.data.report).toMatchObject({ state: "done" });
    expect(r.data.report.text).toContain("Comparison matrix");
    expect(r.data.report.competitors[0].name).toBe("Rival");
    expect((await call(tool, env.ctx, "GET", "reports")).data.reports.length).toBe(1);
  });

  it("refuses a report with nothing analysed", async () => {
    expect((await call(tool, env.other, "POST", "report")).status).toBe(409);
  });

  it("uses the Brave search API when SEARCH_API_KEY is set (fixed host, key never returned)", async () => {
    process.env.SEARCH_API_KEY = "brave-secret-key";
    const seen: { url: string; headers: Record<string, string> }[] = [];
    deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
      return Response.json({ web: { results: [{ title: "Trim Pro", url: "https://trimpro.com/about", description: "Barber <b>booking</b>" }, { title: "Plain http", url: "http://insecure.com/" }, { title: "Test Co A", url: "https://testco.com/" }] } });
    }) as typeof fetch;
    try {
      const r = await call(tool, env.ctx, "POST", "discover", { query: "alternatives to Rival" });
      expect(r.status).toBe(200);
      expect(r.data.source).toBe("search");
      expect(r.data.results).toEqual([{ title: "Trim Pro", url: "https://trimpro.com/", description: "Barber booking" }, { title: "Test Co A", url: "https://testco.com/", description: "" }]);
      expect(new URL(seen[0].url).host).toBe("api.search.brave.com");
      expect(seen[0].headers["x-subscription-token"]).toBe("brave-secret-key");
      expect(JSON.stringify(r.data)).not.toContain("brave-secret-key");
      expect((await call(tool, env.ctx, "GET", "status")).data.searchEnabled).toBe(true);
    } finally {
      delete process.env.SEARCH_API_KEY;
      deps.fetch = ORIGINAL.fetch;
    }
  });

  it("publishes facts, describe, attention, search and resolve", async () => {
    const f = await tool.facts!(env.ctx);
    expect(f).toMatchObject({ competitorCount: 4, competitors: expect.arrayContaining(["Rival"]) });
    expect(typeof f.lastResearchAt).toBe("string");
    const d = await tool.describe!(env.ctx);
    expect(d).toMatch(/Tracking 4 competitors/);
    expect(d).toMatch(/1 analysed/);
    expect(d.length).toBeLessThanOrEqual(600);
    expect(await tool.search!(env.ctx, "riv", 5)).toContainEqual(expect.objectContaining({ title: "Rival", href: `/app/t/competitors/${id}` }));
    expect(await tool.resolve!(env.ctx, id)).toEqual({ title: "Rival", href: `/app/t/competitors/${id}` });
    expect(await tool.resolve!(env.ctx, "nope")).toBeNull();
    const bc = await env.ctx.context();
    expect(bc.summaries.competitors).toMatch(/Rival/);
    expect((await env.ctx.search("rival")).flatMap((g) => g.hits.map((h) => h.title))).toContain("Rival");
  });

  it("attention: changed pages and analyses older than 90 days", async () => {
    await env.sql`UPDATE competitors_analyses SET created_at = now() - interval '100 days' WHERE business_id = ${env.ctx.businessId}`;
    const att = await tool.attention!(env.ctx);
    expect(att.find((a) => a.id === "competitors-stale")).toMatchObject({ severity: "info", title: expect.stringMatching(/older than 90 days/) });
    await env.sql`UPDATE competitors_pages SET changed = true WHERE competitor_id = ${id} AND url LIKE '%/pricing'`;
    expect((await tool.attention!(env.ctx)).some((a) => a.id === `competitors-changed-${id}`)).toBe(true);
  });

  it("attention: no competitors researched yet is shown only when the business has customers", async () => {
    const empty = await makeTestEnv([tool]);
    try {
      expect(await tool.attention!(empty.ctx)).toEqual([]);
      empty.ctx.business.operations.hasCustomers = true;
      const a = await tool.attention!(empty.ctx);
      expect(a).toEqual([expect.objectContaining({ id: "competitors-none", severity: "info" })]);
      expect(await tool.describe!(empty.ctx)).toBe("");
      expect(await tool.facts!(empty.ctx)).toMatchObject({ competitorCount: 0, lastResearchAt: null });
    } finally {
      await empty.cleanup();
    }
  });

  it("isolates businesses", async () => {
    const mine = await call(tool, env.ctx, "GET", "competitors");
    expect(mine.data.competitors.length).toBe(4);
    const theirs = await call(tool, env.other, "GET", "competitors");
    expect(theirs.data.competitors.map((c: { id: string }) => c.id)).not.toContain(id);
    for (const [m, p] of [["GET", `competitors/${id}`], ["DELETE", `competitors/${id}`], ["POST", `competitors/${id}/fetch`], ["POST", `competitors/${id}/analyze`], ["POST", `competitors/${id}/pages`], ["PATCH", `competitors/${id}`]] as const) {
      expect((await call(tool, env.other, m, p, m === "GET" || m === "DELETE" ? undefined : { url: "https://rival.io/x", name: "x" })).status).toBe(404);
    }
    const [an] = await env.sql<{ id: string }[]>`SELECT id FROM competitors_analyses WHERE competitor_id = ${id} LIMIT 1`;
    expect((await call(tool, env.other, "GET", `competitors/${id}/analyses/${an.id}`)).status).toBe(404);
    const [rep] = await env.sql<{ id: string }[]>`SELECT id FROM competitors_reports WHERE business_id = ${env.ctx.businessId} LIMIT 1`;
    expect((await call(tool, env.other, "GET", `reports/${rep.id}`)).status).toBe(404);
    expect((await call(tool, env.other, "GET", "reports")).data.reports.every((r: { id: string }) => r.id !== rep.id)).toBe(true);
    expect(await tool.resolve!(env.other, id)).toBeNull();
    expect((await tool.search!(env.other, "Rival Scheduler", 5)).map((h) => h.id)).not.toContain(id);
    expect((await tool.facts!(env.other)).competitors).not.toContain("Ghost");
  });

  it("links records across tools", async () => {
    await env.ctx.links.add({ tool: "competitors", id }, { tool: "competitors", id }, "self");
    expect((await env.ctx.links.list({ tool: "competitors", id }))[0]).toMatchObject({ title: "Rival", href: `/app/t/competitors/${id}` });
  });

  it("viewers can read but not change", async () => {
    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      const [row] = await viewer.sql<{ id: string }[]>`INSERT INTO competitors_items (business_id, name, url, created_by) VALUES (${viewer.ctx.businessId}, 'V', 'https://v.com/', 'u') RETURNING id`;
      for (const [m, p, b] of [["POST", "competitors", { name: "x", url: "https://x.com" }], ["POST", "report", undefined], ["POST", "discover", {}], ["POST", `competitors/${row.id}/fetch`, undefined], ["POST", `competitors/${row.id}/analyze`, undefined], ["POST", `competitors/${row.id}/pages`, { url: "https://v.com/a" }], ["DELETE", `competitors/${row.id}`, undefined], ["PATCH", `competitors/${row.id}`, { name: "n" }]] as const) {
        expect((await call(tool, viewer.ctx, m, p, b)).status).toBe(403);
      }
      expect((await call(tool, viewer.ctx, "GET", "competitors")).status).toBe(200);
      expect((await call(tool, viewer.ctx, "GET", `competitors/${row.id}`)).status).toBe(200);
    } finally {
      await viewer.cleanup();
    }
  });

  it("AI unavailable: clear message, and fetched pages remain usable", async () => {
    const noAi = new FakeAi();
    noAi.available = false;
    const e = await makeTestEnv([tool], { ai: noAi });
    try {
      deps.net = makeNet((u) => rivalSite(u)).net;
      const c = await call(tool, e.ctx, "POST", "competitors", { name: "Rival", url: "https://rival.io" });
      expect((await call(tool, e.ctx, "POST", `competitors/${c.data.competitor.id}/fetch`)).status).toBe(200);
      expect((await call(tool, e.ctx, "POST", `competitors/${c.data.competitor.id}/analyze`)).status).toBe(503);
      expect((await call(tool, e.ctx, "POST", "discover", {})).status).toBe(503);
      expect((await call(tool, e.ctx, "GET", "status")).data).toMatchObject({ aiAvailable: false, searchEnabled: false });
    } finally {
      await e.cleanup();
    }
  });

  it("deleting a competitor removes its pages and analyses", async () => {
    expect((await call(tool, env.ctx, "PATCH", `competitors/${id}`, { notes: "updated" })).data.competitor.notes).toBe("updated");
    expect((await call(tool, env.ctx, "DELETE", `competitors/${id}`)).status).toBe(200);
    const [p] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM competitors_pages WHERE competitor_id = ${id}`;
    const [a] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM competitors_analyses WHERE competitor_id = ${id}`;
    expect([p.n, a.n]).toEqual([0, 0]);
  });
});
