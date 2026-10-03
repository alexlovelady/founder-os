import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, FakeAi, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";
import { withPlan } from "./limited";

describe("sops plan limits", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv([tool], { ai: new FakeAi(["# Draft", "# Draft two"]) });
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("counts one ai_request per AI start and refuses with a 402 plan message when used up, starting no job", async () => {
    const { ctx, calls } = withPlan(env.ctx, { limits: { aiRequestsPerMonth: 1 } });
    expect((await call(tool, ctx, "POST", "ai", { action: "draft_sop", process: "Handle a refund" })).status).toBe(202);
    const blocked = await call(tool, ctx, "POST", "ai", { action: "draft_sop", process: "Handle a complaint" });
    expect(blocked.status).toBe(402);
    expect(blocked.data.error).toMatch(/AI requests a month/);
    expect(env.ai.calls).toHaveLength(1);
    expect(calls.map(([m]) => m)).toEqual(["ai_request", "ai_request"]);
  });

  it("does not count invalid requests or polling", async () => {
    const { ctx, calls } = withPlan(env.ctx, { limits: { aiRequestsPerMonth: 5 } });
    expect((await call(tool, ctx, "POST", "ai", { action: "improve" })).status).toBe(400);
    expect((await call(tool, ctx, "GET", "ai/some-job")).status).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it("keeps the SOP builder and the document templates free of any limit, even at zero AI requests", async () => {
    const { ctx, calls } = withPlan(env.ctx, { limits: { aiRequestsPerMonth: 0 } });
    const f = await call(tool, ctx, "POST", "sop/format", { name: "Handle a refund", goal: "Refund fairly", steps: "1. Find the order" });
    expect(f.status).toBe(200);
    const g = await call(tool, ctx, "POST", "generate", { kind: "meeting_agenda", fields: { meeting: "Weekly", topics: "Sales | 10" } });
    expect(g.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
