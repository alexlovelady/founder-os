import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, FakeAi, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";
import { withPlan } from "./limited";

describe("competitors plan limits and features", () => {
  let env: TestEnv;
  let ai: FakeAi;
  const original = process.env.SEARCH_API_KEY;
  const stock = async (k: string) => (k === "competitors" ? (await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM competitors_items WHERE business_id = ${env.ctx.businessId}`)[0].n : 0);

  beforeAll(async () => {
    delete process.env.SEARCH_API_KEY;
    ai = new FakeAi(["- Rival One - a rival", "{}", "SUMMARY: x"]);
    env = await makeTestEnv([tool], { ai });
  });
  afterAll(async () => {
    if (original !== undefined) process.env.SEARCH_API_KEY = original;
    await env.cleanup();
  });

  it("refuses a competitor over the plan limit with a 402 naming the limit, and allows one after a delete", async () => {
    const { ctx, calls } = withPlan(env.ctx, { limits: { competitors: 2 }, stock });
    const a = await call(tool, ctx, "POST", "competitors", { name: "A", url: "https://a-rival.com" });
    expect(a.status).toBe(201);
    expect((await call(tool, ctx, "POST", "competitors", { name: "B", url: "https://b-rival.com" })).status).toBe(201);
    const c = await call(tool, ctx, "POST", "competitors", { name: "C", url: "https://c-rival.com" });
    expect(c.status).toBe(402);
    expect(c.data.error).toMatch(/2 tracked competitors/);
    expect(calls.map(([m]) => m)).toEqual(["competitors", "competitors", "competitors"]);
    expect((await call(tool, ctx, "GET", "competitors")).data.competitors).toHaveLength(2);
    // A duplicate is reported as a duplicate, not as a plan problem.
    expect((await call(tool, ctx, "POST", "competitors", { name: "A again", url: "https://a-rival.com" })).status).toBe(409);
    expect((await call(tool, ctx, "DELETE", `competitors/${a.data.competitor.id}`)).status).toBe(200);
    expect((await call(tool, ctx, "POST", "competitors", { name: "C", url: "https://c-rival.com" })).status).toBe(201);
  });

  it("counts one ai_request each for discovery, analysis and report, and a 402 starts no AI work", async () => {
    const [comp] = await env.sql<{ id: string }[]>`SELECT id FROM competitors_items WHERE business_id = ${env.ctx.businessId} ORDER BY created_at LIMIT 1`;
    await env.sql`
      INSERT INTO competitors_pages (business_id, competitor_id, url, status, title, text_excerpt, content_hash, fetched_at)
      VALUES (${env.ctx.businessId}, ${comp.id}, 'https://b-rival.com/', 'ok', 'B', 'Scheduling for salons', 'h1', now())`;
    await env.sql`
      INSERT INTO competitors_analyses (business_id, competitor_id, result, ai_state)
      VALUES (${env.ctx.businessId}, ${comp.id}, ${env.sql.json({ sources: [], failed: [], parsed: true, claims: [{ field: "positioning", claim: "Salon software", source_url: "https://b-rival.com/", quote: "Scheduling for salons" }] } as never)}, 'done')`;
    const { ctx, calls } = withPlan(env.ctx, { limits: { aiRequestsPerMonth: 3 } });
    expect((await call(tool, ctx, "POST", "discover", {})).status).toBe(202);
    expect((await call(tool, ctx, "POST", `competitors/${comp.id}/analyze`)).status).toBe(202);
    expect((await call(tool, ctx, "POST", "report")).status).toBe(202);
    expect(ai.calls).toHaveLength(3);
    const blocked = await call(tool, ctx, "POST", `competitors/${comp.id}/analyze`);
    expect(blocked.status).toBe(402);
    expect(blocked.data.error).toMatch(/AI requests a month/);
    expect((await call(tool, ctx, "POST", "report")).status).toBe(402);
    expect((await call(tool, ctx, "POST", "discover", {})).status).toBe(402);
    expect(ai.calls).toHaveLength(3);
    expect(calls.every(([m]) => m === "ai_request")).toBe(true);
    const [{ n }] = await env.sql`SELECT count(*)::int AS n FROM competitors_analyses WHERE business_id = ${env.ctx.businessId} AND ai_job_id IS NOT NULL`;
    expect(n).toBe(1);
  });

  it("returns 402 with a plain message when the plan has no competitor research, and still lets people read", async () => {
    const { ctx } = withPlan(env.ctx, { features: { competitorResearch: false } });
    const [comp] = await env.sql<{ id: string }[]>`SELECT id FROM competitors_items WHERE business_id = ${env.ctx.businessId} LIMIT 1`;
    const before = ai.calls.length;
    for (const [m, p, body] of [
      ["POST", "competitors", { name: "Z", url: "https://z-rival.com" }],
      ["POST", `competitors/${comp.id}/fetch`, undefined],
      ["POST", `competitors/${comp.id}/analyze`, undefined],
      ["POST", `competitors/${comp.id}/pages`, { url: "https://b-rival.com/x" }],
      ["POST", "report", undefined],
      ["POST", "discover", {}],
    ] as const) {
      const r = await call(tool, ctx, m, p, body);
      expect(r.status, `${m} ${p}`).toBe(402);
      expect(r.data.error).toMatch(/not included in your plan/);
    }
    expect(ai.calls).toHaveLength(before);
    expect((await call(tool, ctx, "GET", "competitors")).status).toBe(200);
    expect((await call(tool, ctx, "GET", "status")).data.researchIncluded).toBe(false);
    expect((await call(tool, env.ctx, "GET", "status")).data.researchIncluded).toBe(true);
  });
});
