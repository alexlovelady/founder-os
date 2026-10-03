import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, FakeAi, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";
import { withPlan } from "./limited";

describe("marketing plan limits and the template path", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv([tool], { ai: new FakeAi(["Option 1: hello", "VOICE: Plain.", "Option 1: again"]) });
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("counts one ai_request per generate and per brand suggestion, and a 402 starts no AI work", async () => {
    const { ctx, calls } = withPlan(env.ctx, { limits: { aiRequestsPerMonth: 2 } });
    expect((await call(tool, ctx, "POST", "generate", { kind: "social_post", topic: "Spring offer" })).status).toBe(202);
    expect((await call(tool, ctx, "POST", "brand/suggest", { notes: "friendly" })).status).toBe(202);
    const blocked = await call(tool, ctx, "POST", "generate", { kind: "email", topic: "Welcome email" });
    expect(blocked.status).toBe(402);
    expect(blocked.data.error).toMatch(/AI requests a month/);
    expect(env.ai.calls).toHaveLength(2);
    expect(calls.map(([m]) => m)).toEqual(["ai_request", "ai_request", "ai_request"]);
    const [{ n }] = await env.sql`SELECT count(*)::int AS n FROM marketing_jobs WHERE business_id = ${env.ctx.businessId}`;
    expect(n).toBe(2);
  });

  it("writes a template draft with no AI and no quota use, says so, even when the AI limit is used up", async () => {
    const { ctx, calls } = withPlan(env.ctx, { limits: { aiRequestsPerMonth: 0 } });
    const before = env.ai.calls.length;
    const r = await call(tool, ctx, "POST", "template", { kind: "email", offer: "free drain inspection", audience: "homeowners", keyPoints: "Fast\nFair", cta: "Call us" });
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ state: "done", method: "template", kind: "email", flags: [], warning: null });
    expect(r.data.label).toMatch(/Template draft/);
    expect(r.data.text).toContain("Subject: Free drain inspection");
    expect(r.data.text).toContain("Test Co A");
    expect(env.ai.calls.length).toBe(before);
    expect(calls).toHaveLength(0);
  });

  it("works with AI turned off, fills gaps with placeholders, and validates the kind", async () => {
    const off = new FakeAi();
    off.available = false;
    const e2 = await makeTestEnv([tool], { ai: off });
    try {
      const r = await call(tool, e2.ctx, "POST", "template", { kind: "social_post" });
      expect(r.status).toBe(200);
      expect(r.data.text).toContain("[●OFFER]");
      expect((await call(tool, e2.ctx, "POST", "template", { kind: "nope" })).status).toBe(400);
    } finally {
      await e2.cleanup();
    }
  });

  it("uses the saved brand tone when none is chosen, and viewers cannot use it", async () => {
    await call(tool, env.ctx, "PUT", "brand", { voice: "Fun", tone: { formal: 10, playful: 90, bold: 50, warm: 50 } });
    const r = await call(tool, env.ctx, "POST", "template", { kind: "email", offer: "x offer", audience: "dog owners" });
    expect(r.data.text).toContain("Hey there!");
    const v = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await call(tool, v.ctx, "POST", "template", { kind: "email" })).status).toBe(403);
    } finally {
      await v.cleanup();
    }
  });

  it("labels AI drafts as AI", async () => {
    const s = await call(tool, env.ctx, "POST", "generate", { kind: "social_post", topic: "Another offer" });
    const p = await call(tool, env.ctx, "GET", `jobs/${s.data.id}`);
    expect(p.data).toMatchObject({ method: "ai", label: "AI draft, review before use" });
  });
});
