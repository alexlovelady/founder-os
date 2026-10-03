import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { toYmd, type Rule } from "../src/engine";
import { ConditionSchema, ConditionsSchema, isHttpsUrl, publishProblems, AdminRuleContent, toEngineRule, CreateAdminRule } from "../src/rule-schema";
import {
  AdminRuleError, createAdminRule, disableAdminRule, getAdminRule, listAdminRules, loadPublishedRules, loadStaleQueue, markAdminRuleVerified, publishAdminRule,
  recordSourceCheck, restoreAdminRuleVersion, staleQueue, updateAdminRule,
} from "../src/admin-rules";
import { previewRule, SAMPLE_PROFILES } from "../src/samples";
import { checkSourceUrl, isPublicIp, normalizeCheckUrl, type NetDeps, type RawResponse } from "../src/source-check";
import { RULES } from "../src/seed";
import { syncChecklist, tool } from "../src/index";

const today = toYmd(new Date());
const ago = (days: number) => toYmd(new Date(Date.now() - days * 86400000));
const uid = () => Math.random().toString(36).slice(2, 8);

const content = (over: Record<string, unknown> = {}) => ({
  title: "Contractor safety notice", description: "Plain-words description.", category: "contractor documentation",
  conditions: [{ type: "flag", key: "usesContractors" }], recommendation: "Keep a signed safety notice from each contractor.",
  cautious: "Review whether you need a safety notice from your contractors.", sourceTitle: "Example Agency: Contractor safety", sourceUrl: "https://www.example.gov/safety",
  jurisdiction: "US", lastVerified: today, recurrence: null, ...over,
});
const create = (sql: TestEnv["sql"], slug: string, over: Record<string, unknown> = {}) => createAdminRule(sql, "admin-1", { slug, ...content(over) });

describe("condition schema (the engine's condition language)", () => {
  it.each([
    [{ type: "country", in: ["US"] }],
    [{ type: "state", is: "nc" }],
    [{ type: "entity", in: ["llc"] }],
    [{ type: "stage", notIn: ["idea"] }],
    [{ type: "stage", in: ["operating"] }],
    [{ type: "flag", key: "usesContractors" }],
    [{ type: "flag", key: "hasWebsite", value: false }],
    [{ type: "employees", min: 1 }],
    [{ type: "industry", any: ["restaurant"] }],
    [{ type: "industryKnown" }],
    [{ type: "anyOf", of: [{ type: "flag", key: "a" }, { type: "anyOf", of: [{ type: "employees", min: 2 }] }] }],
  ])("accepts %j", (c) => {
    expect(ConditionSchema.safeParse(c).success).toBe(true);
  });
  it.each([
    [{ type: "magic" }],
    [{ type: "state", is: "ZZ" }],
    [{ type: "state", is: "North Carolina" }],
    [{ type: "stage" }],
    [{ type: "country", in: [] }],
    [{ type: "flag", key: "has space" }],
    [{ type: "employees", min: -1 }],
    [{ type: "employees", min: 1.5 }],
    [{ type: "country", in: ["US"], extra: 1 }],
    [{ type: "anyOf", of: [] }],
    [{ type: "anyOf", of: [{ type: "anyOf", of: [{ type: "anyOf", of: [{ type: "anyOf", of: [{ type: "industryKnown" }] }] }] }] }],
  ])("rejects %j", (c) => {
    expect(ConditionSchema.safeParse(c).success).toBe(false);
  });
  it("normalises a state code to upper case and caps the number of conditions", () => {
    expect(ConditionSchema.parse({ type: "state", is: "nc" })).toEqual({ type: "state", is: "NC" });
    expect(ConditionsSchema.safeParse(Array.from({ length: 13 }, () => ({ type: "industryKnown" }))).success).toBe(false);
  });
});

describe("publish rules (spec 62: no untraceable content)", () => {
  const c = AdminRuleContent.parse(content());
  it("accepts a complete rule", () => expect(publishProblems("ok", c)).toEqual([]));
  it("requires an https source URL, a title and a last-verified date", () => {
    expect(publishProblems("x", { ...c, sourceUrl: "" })).toContain("A source URL is required to publish");
    expect(publishProblems("x", { ...c, sourceTitle: "" })).toContain("A source title is required to publish");
    expect(publishProblems("x", { ...c, lastVerified: null })).toContain("A last-verified date is required to publish");
    expect(publishProblems("x", { ...c, lastVerified: ago(-3) })).toContain("The last-verified date cannot be in the future");
    expect(publishProblems("x", { ...c, conditions: [] }).join()).toMatch(/at least one condition/);
  });
  it("rejects assertive wording on a cautious rule", () => {
    expect(publishProblems("x", { ...c, alwaysCautious: true, recommendation: "You must file this." }).join()).toMatch(/assertive/);
  });
  it("validates https URLs", () => {
    expect(isHttpsUrl("https://www.irs.gov/a?b=1")).toBe(true);
    for (const u of ["http://www.irs.gov", "ftp://x.gov/a", "javascript:alert(1)", "https://user:pw@x.gov/", "https://localhost", "not a url", "https://a b.gov"]) expect(isHttpsUrl(u), u).toBe(false);
    expect(CreateAdminRule.safeParse({ slug: "ab", ...content({ sourceUrl: "http://insecure.gov" }) }).success).toBe(false);
  });
  it("namespaces the engine rule id", () => {
    expect(toEngineRule("my-rule", 3, c)).toMatchObject({ id: "admin:my-rule", version: 3, source: { url: "https://www.example.gov/safety" } });
    expect(CreateAdminRule.safeParse({ slug: "Bad Slug!", ...content() }).success).toBe(false);
  });
});

describe("stale queue (pure)", () => {
  const e = (ruleId: string, lastVerified: string | null, status: "draft" | "published" | "disabled" | null = null) => ({ ruleId, title: ruleId, origin: (status ? "admin" : "seed") as "admin" | "seed", status, sourceTitle: "s", sourceUrl: "https://x.gov", lastVerified });
  it("lists rules older than 180 days (or never verified), oldest first, skipping disabled", () => {
    const q = staleQueue([e("fresh", ago(10)), e("edge", ago(180)), e("old", ago(181)), e("older", ago(400)), e("never", null), e("off", ago(900), "disabled"), e("adm", ago(300), "published")], today);
    expect(q.map((r) => r.ruleId)).toEqual(["never", "older", "adm", "old"]);
    expect(q[1].ageDays).toBe(400);
    expect(q[0].ageDays).toBeNull();
  });
});

describe("sample preview", () => {
  it("evaluates a rule against the built-in sample businesses with the real engine", () => {
    expect(SAMPLE_PROFILES.length).toBe(6);
    const rule = toEngineRule("p", 1, AdminRuleContent.parse(content({ alwaysCautious: false, conditions: [{ type: "country", in: ["US"] }, { type: "flag", key: "usesContractors" }] })));
    const rows = previewRule(rule);
    expect(rows).toHaveLength(6);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by["tx-solo-contractors"]).toMatchObject({ applies: true, certainty: "certain" });
    expect(by["nc-llc-employees"].applies).toBe(false); // answered "no" to contractors
    expect(by["fl-unknown-answers"]).toMatchObject({ applies: true, certainty: "uncertain", wording: expect.stringMatching(/^Review whether/) });
    expect(by["ca-canada"].applies).toBe(false);
  });
});

describe("source check (injected network, no internet)", () => {
  const res = (status: number, headers: Record<string, string> = {}): RawResponse => ({ status, headers, destroy() {} });
  const net = (routes: Record<string, RawResponse | (() => Promise<RawResponse>)>, dns: Record<string, string[]> = {}): NetDeps & { requested: string[] } => {
    const requested: string[] = [];
    return {
      requested,
      resolve: async (h) => dns[h] ?? ["93.184.216.34"],
      request: async ({ url }) => {
        requested.push(url.toString());
        const r = routes[url.toString()];
        if (!r) throw new Error("no route");
        return typeof r === "function" ? r() : r;
      },
    };
  };

  it("reports status and final URL after following redirects", async () => {
    const n = net({ "https://a.example.gov/old": res(301, { location: "/new" }), "https://a.example.gov/new": res(200) });
    const r = await checkSourceUrl("https://a.example.gov/old", n);
    expect(r).toMatchObject({ ok: true, status: 200, finalUrl: "https://a.example.gov/new", redirects: 1, blocked: null });
  });
  it("reports a 404 as a status, not an error", async () => {
    const r = await checkSourceUrl("https://a.example.gov/gone", net({ "https://a.example.gov/gone": res(404) }));
    expect(r).toMatchObject({ ok: false, status: 404, blocked: null });
  });
  it("never contacts private, loopback or metadata addresses (literal or via DNS)", async () => {
    const n = net({}, { "evil.example.com": ["10.0.0.5"], "mixed.example.com": ["93.184.216.34", "169.254.169.254"] });
    for (const u of ["https://127.0.0.1/", "https://169.254.169.254/latest/meta-data", "https://[::1]/", "https://evil.example.com/", "https://mixed.example.com/", "https://localhost/", "https://intranet/"]) {
      const r = await checkSourceUrl(u, n);
      expect(r, u).toMatchObject({ ok: false, status: null, blocked: "private" });
    }
    expect(n.requested).toEqual([]);
  });
  it("blocks a redirect into a private network", async () => {
    const n = net({ "https://a.example.gov/": res(302, { location: "https://192.168.1.1/admin" }) });
    expect(await checkSourceUrl("https://a.example.gov/", n)).toMatchObject({ status: null, blocked: "private" });
    expect(n.requested).toEqual(["https://a.example.gov/"]);
  });
  it("upgrades http to https and refuses other schemes, ports and credentials", async () => {
    const n = net({ "https://a.example.gov/x": res(200) });
    expect(await checkSourceUrl("http://a.example.gov/x", n)).toMatchObject({ ok: true, finalUrl: "https://a.example.gov/x" });
    expect(await checkSourceUrl("ftp://a.example.gov/x", n)).toMatchObject({ blocked: "scheme" });
    expect(await checkSourceUrl("https://a.example.gov:8443/x", n)).toMatchObject({ blocked: "port" });
    expect(await checkSourceUrl("https://u:p@a.example.gov/x", n)).toMatchObject({ blocked: "invalid" });
    expect(await checkSourceUrl("nonsense", n)).toMatchObject({ blocked: "invalid" });
  });
  it("stops after too many redirects", async () => {
    const n = net({ "https://a.example.gov/": res(302, { location: "/" }) });
    expect(await checkSourceUrl("https://a.example.gov/", n, { maxRedirects: 2 })).toMatchObject({ blocked: "redirects", status: null });
  });
  it("times out", async () => {
    const n = net({ "https://slow.example.gov/": () => new Promise<RawResponse>(() => {}) });
    expect(await checkSourceUrl("https://slow.example.gov/", n, { timeoutMs: 50 })).toMatchObject({ blocked: "timeout", status: null });
  });
  it("reports unreachable hosts and DNS failures", async () => {
    expect(await checkSourceUrl("https://nowhere.example.gov/", net({}))).toMatchObject({ blocked: "network" });
    const n: NetDeps = { resolve: async () => { throw new Error("nx"); }, request: async () => res(200) };
    expect(await checkSourceUrl("https://nx.example.gov/", n)).toMatchObject({ blocked: "dns" });
  });
  it("address classification", () => {
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) expect(isPublicIp(ip), ip).toBe(true);
    for (const ip of ["10.1.1.1", "172.16.0.1", "192.168.0.1", "127.0.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "224.0.0.1", "abc"]) expect(isPublicIp(ip), ip).toBe(false);
    expect(normalizeCheckUrl("http://Example.GOV./a#frag").toString()).toBe("https://example.gov/a");
  });
});

describe("admin rules in the database and the checklist sync", () => {
  let env: TestEnv;
  const made: string[] = [];
  const slug = () => { const s = `t-${uid()}`; made.push(s); return s; };

  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    await env.sql`DELETE FROM compliance_admin_rules WHERE id LIKE 't-%'`;
  });
  afterAll(async () => {
    if (made.length) await env.sql`DELETE FROM compliance_admin_rules WHERE id = ANY(${made})`;
    await env.cleanup();
  });
  const items = async (ctx = env.ctx) => (await call(tool, ctx, "GET", "items")).data.items as { id: string; ruleId: string | null; recommendation: string; title: string; status: string; notes: string; sourceUrl: string; lastVerified: string | null }[];
  const find = async (ruleId: string, ctx = env.ctx) => (await items(ctx)).find((i) => i.ruleId === ruleId);

  it("creates global tables without business_id, as a draft that reaches nobody", async () => {
    const cols = await env.sql<{ table_name: string; column_name: string }[]>`SELECT table_name, column_name FROM information_schema.columns WHERE table_name LIKE 'compliance_admin_%' AND column_name = 'business_id'`;
    expect(cols).toEqual([]);
    const s = slug();
    const r = await create(env.sql, s);
    expect(r).toMatchObject({ slug: s, ruleId: `admin:${s}`, version: 1, status: "draft", enabled: false });
    expect((await loadPublishedRules(env.sql)).some((x) => x.id === `admin:${s}`)).toBe(false);
    await syncChecklist(env.ctx);
    expect(await find(`admin:${s}`)).toBeUndefined();
    await expect(create(env.sql, s)).rejects.toMatchObject({ status: 409 });
    await expect(createAdminRule(env.sql, "a", { slug: "x", title: "" })).rejects.toBeInstanceOf(AdminRuleError);
  });

  it("refuses to publish without a source URL or a last-verified date, and never reaches businesses", async () => {
    const noSource = await create(env.sql, slug(), { sourceUrl: "", sourceTitle: "" });
    await expect(publishAdminRule(env.sql, "a", noSource.slug)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("source URL") });
    const noDate = await create(env.sql, slug(), { lastVerified: null });
    await expect(publishAdminRule(env.sql, "a", noDate.slug)).rejects.toMatchObject({ status: 400, message: expect.stringContaining("last-verified") });
    expect((await getAdminRule(env.sql, noDate.slug))!.rule.status).toBe("draft");
    await expect(publishAdminRule(env.sql, "a", "t-missing")).rejects.toMatchObject({ status: 404 });
  });

  it("merges: a published admin rule joins the seed rules in every business's sync, idempotently", async () => {
    const s = slug();
    await create(env.sql, s);
    await publishAdminRule(env.sql, "admin-1", s);
    const before = (await items()).length;
    const r1 = await syncChecklist(env.ctx);
    expect(r1.inserted).toBeGreaterThanOrEqual(1);
    const it1 = await find(`admin:${s}`);
    expect(it1).toMatchObject({ title: "Contractor safety notice", status: "missing", sourceUrl: "https://www.example.gov/safety", lastVerified: today, recommendation: "Keep a signed safety notice from each contractor." });
    expect((await items()).length).toBeGreaterThan(before);
    expect(await syncChecklist(env.ctx)).toMatchObject({ inserted: 0, refreshed: 0, removed: 0 });
    // The existing seed behaviour is untouched.
    expect(await find("fed-ein")).toBeTruthy();
    expect((await call(tool, env.ctx, "GET", "rules")).data).toMatchObject({ adminRules: expect.any(Number), totalRules: RULES.length + (await loadPublishedRules(env.sql)).length });
  });

  it("applies the rule's conditions: a rule for another state creates nothing", async () => {
    const s = slug();
    await create(env.sql, s, { conditions: [{ type: "state", is: "TX" }, { type: "entity", in: ["llc"] }] });
    await publishAdminRule(env.sql, "a", s);
    await syncChecklist(env.ctx);
    expect(await find(`admin:${s}`)).toBeUndefined();
  });

  it("versioning: editing a published rule bumps the version and refreshes untouched items, keeping status and notes", async () => {
    const s = slug();
    await create(env.sql, s);
    await publishAdminRule(env.sql, "a", s);
    await syncChecklist(env.ctx);
    const it0 = (await find(`admin:${s}`))!;
    await call(tool, env.ctx, "PATCH", `items/${it0.id}`, { notes: "my note", status: "attention" });
    const { rule, changed } = await updateAdminRule(env.sql, "admin-2", s, content({ recommendation: "Updated wording.", title: "Contractor safety notice (2027)" }));
    expect(changed).toBe(true);
    expect(rule.version).toBe(2);
    const noChange = await updateAdminRule(env.sql, "admin-2", s, content({ recommendation: "Updated wording.", title: "Contractor safety notice (2027)" }));
    expect(noChange.changed).toBe(false);
    expect(noChange.rule.version).toBe(2);
    expect(await syncChecklist(env.ctx)).toMatchObject({ refreshed: 1 });
    expect(await find(`admin:${s}`)).toMatchObject({ id: it0.id, recommendation: "Updated wording.", title: "Contractor safety notice (2027)", status: "attention", notes: "my note" });
    const detail = (await getAdminRule(env.sql, s))!;
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1, 1]); // created, published, edited (newest first)
    expect(detail.rule.updatedBy).toBe("admin-2");
  });

  it("a published rule cannot be edited into an unpublishable state; a draft can be incomplete", async () => {
    const s = slug();
    await create(env.sql, s);
    await publishAdminRule(env.sql, "a", s);
    await expect(updateAdminRule(env.sql, "a", s, content({ sourceUrl: "" }))).rejects.toMatchObject({ status: 400 });
    await expect(updateAdminRule(env.sql, "a", s, content({ sourceUrl: "http://nope.gov" }))).rejects.toMatchObject({ status: 400 });
    const d = await create(env.sql, slug(), { sourceUrl: "" });
    const edited = await updateAdminRule(env.sql, "a", d.slug, content({ sourceUrl: "", title: "Still a draft" }));
    expect(edited.rule).toMatchObject({ version: 1, status: "draft" });
  });

  it("restore re-applies an earlier version as a NEW version", async () => {
    const s = slug();
    await create(env.sql, s);
    await publishAdminRule(env.sql, "a", s);
    await updateAdminRule(env.sql, "a", s, content({ recommendation: "Second wording." }));
    const restored = await restoreAdminRuleVersion(env.sql, "admin-3", s, 1);
    expect(restored.version).toBe(3);
    expect(restored.content.recommendation).toBe("Keep a signed safety notice from each contractor.");
    expect((await getAdminRule(env.sql, s))!.versions[0]).toMatchObject({ version: 3, note: "restored from v1" });
    await expect(restoreAdminRuleVersion(env.sql, "a", s, 99)).rejects.toMatchObject({ status: 404 });
    await syncChecklist(env.ctx);
    expect((await find(`admin:${s}`))!.recommendation).toBe("Keep a signed safety notice from each contractor.");
  });

  it("disable removes untouched items that came only from the rule, keeps touched ones, and republishing brings it back as a new version", async () => {
    const s = slug();
    await create(env.sql, s);
    await publishAdminRule(env.sql, "a", s);
    await syncChecklist(env.ctx);
    await syncChecklist(env.other);
    const touched = (await find(`admin:${s}`, env.other))!;
    await call(tool, env.other, "PATCH", `items/${touched.id}`, { status: "complete" });
    expect(await find(`admin:${s}`)).toBeTruthy();

    const off = await disableAdminRule(env.sql, "admin-1", s);
    expect(off).toMatchObject({ status: "disabled", enabled: false });
    expect((await loadPublishedRules(env.sql)).some((r) => r.id === `admin:${s}`)).toBe(false);
    expect(await syncChecklist(env.ctx)).toMatchObject({ removed: expect.any(Number) });
    expect(await find(`admin:${s}`)).toBeUndefined(); // untouched: removed
    await syncChecklist(env.other);
    expect(await find(`admin:${s}`, env.other)).toMatchObject({ status: "complete" }); // the user touched it: kept

    await expect(disableAdminRule(env.sql, "a", s)).resolves.toMatchObject({ status: "disabled" }); // idempotent
    const again = await publishAdminRule(env.sql, "a", s);
    expect(again).toMatchObject({ status: "published", enabled: true, version: 2 });
    await syncChecklist(env.ctx);
    expect(await find(`admin:${s}`)).toMatchObject({ status: "missing" });
    await expect(disableAdminRule(env.sql, "a", (await create(env.sql, slug())).slug)).rejects.toMatchObject({ status: 400 }); // drafts cannot be "disabled"
  });

  it("cross-business: a global rule applies to every business, but items stay tenant-scoped", async () => {
    const s = slug();
    await create(env.sql, s);
    await publishAdminRule(env.sql, "a", s);
    await syncChecklist(env.ctx);
    const mine = (await find(`admin:${s}`))!;
    // The other business has not synced yet: it sees nothing of this rule.
    expect((await items(env.other)).some((i) => i.ruleId === `admin:${s}`)).toBe(false);
    await syncChecklist(env.other);
    const theirs = (await find(`admin:${s}`, env.other))!;
    expect(theirs.id).not.toBe(mine.id);
    // Changing one business's item does not touch the other's, and neither can address the other's row.
    await call(tool, env.ctx, "PATCH", `items/${mine.id}`, { status: "complete", notes: "done here" });
    expect(await find(`admin:${s}`, env.other)).toMatchObject({ status: "missing", notes: "" });
    expect((await call(tool, env.other, "PATCH", `items/${mine.id}`, { status: "complete" })).status).toBe(404);
    const rows = await env.sql<{ business_id: string }[]>`SELECT business_id FROM compliance_items WHERE rule_id = ${`admin:${s}`}`;
    expect(new Set(rows.map((r) => r.business_id))).toEqual(new Set([env.ctx.businessId, env.other.businessId]));
    // Per-business profile still decides applicability.
    const tx = { ...env.other, business: { ...env.other.business, operations: { usesContractors: false } } };
    const s2 = slug();
    await create(env.sql, s2);
    await publishAdminRule(env.sql, "a", s2);
    await syncChecklist(tx);
    expect(await find(`admin:${s2}`, env.other)).toBeUndefined();
  });

  it("viewers cannot sync (and so cannot pull admin rules into a checklist)", async () => {
    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await call(tool, viewer.ctx, "POST", "sync")).status).toBe(403);
    } finally {
      await viewer.cleanup();
    }
  });

  it("mark verified moves the date to today as a new version and drops the rule out of the stale queue", async () => {
    const s = slug();
    await create(env.sql, s, { lastVerified: ago(200) });
    await publishAdminRule(env.sql, "a", s);
    let q = await loadStaleQueue(env.sql, today);
    expect(q.find((e) => e.ruleId === `admin:${s}`)).toMatchObject({ origin: "admin", status: "published", ageDays: 200 });
    const v = await markAdminRuleVerified(env.sql, "admin-1", s, today);
    expect(v).toMatchObject({ version: 2 });
    expect(v.content.lastVerified).toBe(today);
    q = await loadStaleQueue(env.sql, today);
    expect(q.some((e) => e.ruleId === `admin:${s}`)).toBe(false);
    expect((await markAdminRuleVerified(env.sql, "a", s, today)).version).toBe(2); // already today: no change
    await syncChecklist(env.ctx);
    expect((await find(`admin:${s}`))!.lastVerified).toBe(today);
  });

  it("stale queue includes seed rules that have never been verified, oldest first", async () => {
    const q = await loadStaleQueue(env.sql, toYmd(new Date(Date.now() + 400 * 86400000)));
    expect(q.some((e) => e.origin === "seed")).toBe(true);
    const dates = q.map((e) => e.lastVerified ?? "");
    expect([...dates].sort()).toEqual(dates);
  });

  it("stores the result of a source check without creating a new version", async () => {
    const s = slug();
    const r = await create(env.sql, s);
    const out = await recordSourceCheck(env.sql, s, { status: 200, finalUrl: "https://www.example.gov/safety", note: "ok" });
    expect(out.lastCheck).toMatchObject({ status: 200, finalUrl: "https://www.example.gov/safety", note: "ok" });
    expect(out.version).toBe(r.version);
    expect((await getAdminRule(env.sql, s))!.versions).toHaveLength(1);
    await expect(recordSourceCheck(env.sql, "t-nope", { status: null, finalUrl: null, note: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("lists rules newest-updated first", async () => {
    const all = await listAdminRules(env.sql);
    expect(all.length).toBeGreaterThan(5);
    const t = all.map((r) => r.updatedAt);
    expect([...t].sort().reverse()).toEqual(t);
  });

  it("skips a stored row that no longer validates instead of breaking every business's sync", async () => {
    const s = slug();
    await create(env.sql, s);
    await publishAdminRule(env.sql, "a", s);
    await env.sql`UPDATE compliance_admin_rules SET conditions = '[{"type":"bogus"}]'::jsonb WHERE id = ${s}`;
    const rules: Rule[] = await loadPublishedRules(env.sql);
    expect(rules.some((r) => r.id === `admin:${s}`)).toBe(false);
    await expect(syncChecklist(env.ctx)).resolves.toBeTruthy();
  });
});
