import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, FakeAi, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { checkClaims } from "../src/guard";
import { cleanAiText, parseBrandSuggestion } from "../src/prompts";
import { tool } from "../src/index";

describe("fabricated claim check", () => {
  it("flags numbers, percentages, prices, testimonials, guarantees and awards the user never gave", () => {
    const out = `We saved clients 40% on bills. Over 2,500 customers trust us for 15 years. Only $99! "Best service I ever had in my life" - Sarah. 100% money-back guarantee. Award-winning and 5-star rated.`;
    const kinds = checkClaims(out, ["Plumbing in Charlotte"]).map((f) => f.kind);
    for (const k of ["percentage", "number", "money", "testimonial", "guarantee", "superlative", "rating"]) expect(kinds).toContain(k);
  });
  it("allows what the user supplied and ignores placeholders and years", () => {
    const sources = ["We offer 20% off for new customers, family run for 12 years. Call 555 0100. $49 tune-up. 30-day guarantee"];
    expect(checkClaims("Get 20% off. Family run for 12 years. $49 tune-up with our 30-day guarantee. Since 2019.", sources)).toEqual([]);
    expect(checkClaims("Save [●PERCENT]% today, just [●PRICE]. [●CUSTOMER QUOTE]", [""])).toEqual([]);
    expect(checkClaims("Open 7 days a week. Top 3 tips. Step 2.", [""])).toEqual([]);
  });
  it("flags only the unsupported part", () => {
    const flags = checkClaims("Get 20% off, or 50% off!", ["20% off"]);
    expect(flags.map((f) => f.text)).toEqual(["50%"]);
  });
  it("accepts a quote the user supplied", () => {
    const quote = "Fast, friendly and fair priced work";
    expect(checkClaims(`"${quote}" - Pat`, [`Customer said: ${quote}`])).toEqual([]);
  });
});

describe("text helpers", () => {
  it("cleans chatter and parses the brand suggestion", () => {
    expect(cleanAiText("Sure! Here are your posts:\n\nOption 1: hi\n\nLet me know if you want changes!")).toBe("Option 1: hi");
    const p = parseBrandSuggestion("VOICE: Warm and plain.\nAUDIENCE: Local homeowners\nOFFERS: Drain cleaning\nDO: friendly, local\nDONT: cheap");
    expect(p).toEqual({ voice: "Warm and plain.", audience: "Local homeowners", offers: "Drain cleaning", doWords: "friendly, local", dontWords: "cheap" });
  });
});

describe("marketing tool (database)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv([tool], {
      ai: new FakeAi([
        "Sure! Here you go:\n\nVOICE: Warm, plain-spoken and local.\nAUDIENCE: Charlotte homeowners\nOFFERS: [●OFFERS]\nDO: friendly\nDONT: cheap",
        "Option 1: Spring special! Save 40% and join 1,200 happy customers. [●CUSTOMER QUOTE]",
        "Subject: Following up\n\nHi, just checking in.",
      ]),
    });
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("starts with no brand voice and saves one (upsert, validated)", async () => {
    expect((await call(tool, env.ctx, "GET", "brand")).data).toMatchObject({ saved: false });
    expect(await tool.facts!(env.ctx)).toMatchObject({ hasBrandVoice: false });
    const body = { voice: "Warm, plain-spoken.", audience: "Homeowners", offers: "Drain cleaning", doWords: "friendly", dontWords: "cheap", tone: { formal: 20, playful: 60, bold: 40, warm: 90 } };
    expect((await call(tool, env.ctx, "PUT", "brand", body)).status).toBe(200);
    expect((await call(tool, env.ctx, "PUT", "brand", { ...body, voice: "Warm and local." })).status).toBe(200);
    const g = (await call(tool, env.ctx, "GET", "brand")).data;
    expect(g).toMatchObject({ saved: true, brand: { voice: "Warm and local.", tone: { warm: 90 } } });
    expect((await call(tool, env.ctx, "PUT", "brand", { ...body, tone: { formal: 500 } })).status).toBe(400);
    const [{ n }] = await env.sql`SELECT count(*)::int AS n FROM marketing_brand WHERE business_id = ${env.ctx.businessId}`;
    expect(n).toBe(1);
  });

  it("suggests a brand voice through an async job", async () => {
    const s = await call(tool, env.ctx, "POST", "brand/suggest", { notes: "friendly" });
    expect(s.status).toBe(202);
    const p = await call(tool, env.ctx, "GET", `jobs/${s.data.id}`);
    expect(p.data).toMatchObject({ state: "done", suggestion: { voice: "Warm, plain-spoken and local.", audience: "Charlotte homeowners" } });
    expect(env.ai.calls[0].prompt).toContain("Test Co A");
  });

  it("generates copy asynchronously, grounded in brand and context, and flags invented claims", async () => {
    const s = await call(tool, env.ctx, "POST", "generate", { kind: "social_post", topic: "Spring drain check offer", channel: "Instagram", details: "Free inspection for new customers" });
    expect(s.status).toBe(202);
    const p = await call(tool, env.ctx, "GET", `jobs/${s.data.id}`);
    expect(p.data.state).toBe("done");
    expect(p.data.label).toBe("AI draft, review before use");
    expect(p.data.flags.map((f: { text: string }) => f.text)).toEqual(expect.arrayContaining(["40%", "1,200 happy"]));
    expect(p.data.warning).toBeTruthy();
    const req = env.ai.calls[1];
    expect(req.prompt).toContain("Test Co A");
    expect(req.prompt).toContain("Warm and local.");
    expect(req.prompt).toContain("Spring drain check offer");
    expect(req.system).toMatch(/NEVER invent customer testimonials/);
  });

  it("validates generation input and job ids", async () => {
    expect((await call(tool, env.ctx, "POST", "generate", { kind: "nope", topic: "abc" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "generate", { kind: "email", topic: "x" })).status).toBe(400);
    expect((await call(tool, env.ctx, "GET", "jobs/not-a-uuid")).status).toBe(404);
  });

  it("saves items, validates, schedules, and lists a calendar", async () => {
    expect((await call(tool, env.ctx, "POST", "items", { kind: "social_post", title: "", body: "x" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "items", { kind: "social_post", title: "t", scheduled_for: "2026-02-31" })).status).toBe(400);
    const a = await call(tool, env.ctx, "POST", "items", { kind: "email", title: "Customer follow-up email", body: "Thanks for choosing us", channel: "email", scheduled_for: "2026-11-05" });
    expect(a.status).toBe(201);
    const b = await call(tool, env.ctx, "POST", "items", { kind: "social_post", title: "Spring post", body: "Fresh spring offers" });
    const u = await call(tool, env.ctx, "PUT", `items/${b.data.item.id}`, { status: "ready", scheduled_for: "2026-11-01" });
    expect(u.data.item).toMatchObject({ status: "ready", scheduledFor: "2026-11-01", title: "Spring post" });
    const cal = await call(tool, env.ctx, "GET", "calendar");
    expect(cal.data.items.map((i: { title: string }) => i.title)).toEqual(["Spring post", "Customer follow-up email"]);
    expect(cal.data.note).toMatch(/Nothing is posted/);
    expect((await call(tool, env.ctx, "GET", "items?kind=email")).data.items).toHaveLength(1);
    expect((await call(tool, env.ctx, "PUT", `items/${b.data.item.id}`, { scheduled_for: null })).data.item.scheduledFor).toBeNull();
  });

  it("isolates businesses", async () => {
    const mine = (await call(tool, env.ctx, "GET", "items")).data.items[0];
    expect((await call(tool, env.other, "GET", "items")).data.items).toEqual([]);
    expect((await call(tool, env.other, "GET", `items/${mine.id}`)).status).toBe(404);
    expect((await call(tool, env.other, "PUT", `items/${mine.id}`, { title: "x" })).status).toBe(404);
    expect((await call(tool, env.other, "DELETE", `items/${mine.id}`)).status).toBe(404);
    expect((await call(tool, env.other, "GET", "brand")).data.saved).toBe(false);
    expect(await tool.resolve!(env.other, mine.id)).toBeNull();
    expect(await tool.search!(env.other, "spring", 5)).toEqual([]);
    const s = await call(tool, env.ctx, "POST", "brand/suggest", {});
    expect((await call(tool, env.other, "GET", `jobs/${s.data.id}`)).status).toBe(404);
  });

  it("viewers can read but not change or start AI", async () => {
    const v = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await call(tool, v.ctx, "PUT", "brand", { voice: "x" })).status).toBe(403);
      expect((await call(tool, v.ctx, "POST", "items", { kind: "email", title: "t" })).status).toBe(403);
      expect((await call(tool, v.ctx, "POST", "generate", { kind: "email", topic: "abcd" })).status).toBe(403);
      expect((await call(tool, v.ctx, "GET", "items")).status).toBe(200);
    } finally {
      await v.cleanup();
    }
  });

  it("reports AI as unavailable", async () => {
    const off = new FakeAi();
    off.available = false;
    const e2 = await makeTestEnv([tool], { ai: off });
    try {
      expect((await call(tool, e2.ctx, "POST", "generate", { kind: "email", topic: "welcome email" })).status).toBe(503);
    } finally {
      await e2.cleanup();
    }
  });

  it("publishes facts, describe, search and resolve", async () => {
    const f = await tool.facts!(env.ctx);
    expect(f).toMatchObject({ hasBrandVoice: true, hasFollowUpEmail: true, itemCounts: { total: 2, byKind: { email: 1, social_post: 1 } } });
    const d = await tool.describe!(env.ctx);
    expect(d).toMatch(/Brand voice: Warm and local\./);
    expect(d).toMatch(/1 email/);
    expect(d.length).toBeLessThanOrEqual(600);
    const hit = (await tool.search!(env.ctx, "spring", 5))[0];
    expect(hit).toMatchObject({ title: "Spring post", href: expect.stringContaining("/app/t/marketing/items/") });
    expect(await tool.resolve!(env.ctx, hit.id)).toMatchObject({ title: "Spring post", href: hit.href });
    expect(await tool.resolve!(env.ctx, "nope")).toBeNull();
    expect((await env.ctx.context()).summaries.marketing).toMatch(/Brand voice/);
    await env.ctx.links.add({ tool: "marketing", id: hit.id }, { tool: "marketing", id: hit.id }, "self");
    expect((await env.ctx.links.list({ tool: "marketing", id: hit.id }))[0]).toMatchObject({ title: "Spring post" });
  });

  it("raises an info attention item only for businesses with customers and no brand voice", async () => {
    const e2 = await makeTestEnv([tool]);
    try {
      expect(await tool.attention!(e2.ctx)).toEqual([]);
      const withCustomers = { ...e2.ctx, business: { ...e2.ctx.business, operations: { ...e2.ctx.business.operations, hasCustomers: true } } };
      const a = await tool.attention!(withCustomers);
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({ severity: "info", href: "/app/t/marketing" });
      await call(tool, e2.ctx, "PUT", "brand", { voice: "Plain." });
      expect(await tool.attention!(withCustomers)).toEqual([]);
      expect(await tool.describe!(e2.ctx)).toMatch(/Plain\./);
    } finally {
      await e2.cleanup();
    }
  });
});
