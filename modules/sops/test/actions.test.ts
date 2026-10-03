import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";

const create = () => tool.actions!.find((a) => a.id === "create_sop_draft")!;
const KEY = "fp:sop-key-1";

describe("sops actions (assistant proposals)", () => {
  let env: TestEnv;
  let viewer: TestEnv;
  const docs = async (e: TestEnv) => e.sql`SELECT title, status, kind, owner, version FROM sops_documents WHERE business_id = ${e.ctx.businessId}`;

  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    viewer = await makeTestEnv([tool], { role: "viewer" });
  });
  afterAll(async () => {
    await env.cleanup();
    await viewer.cleanup();
  });

  it("declares one action: create a DRAFT", () => {
    expect(tool.actions!.map((a) => a.id)).toEqual(["create_sop_draft"]);
  });

  it("validates input", () => {
    expect(create().input.safeParse({ title: "", body: "x" }).success).toBe(false);
    expect(create().input.safeParse({ title: "x", body: "" }).success).toBe(false);
    expect(create().input.safeParse({ title: "x", body: "y".repeat(20_001) }).success).toBe(false);
    expect(create().input.safeParse({ title: "x", body: "y", kind: "nonsense" }).success).toBe(false);
  });

  it("preview has no side effects; run saves a draft (never active) once per key, owned by the user", async () => {
    const input = create().input.parse({ title: "Handling a refund", body: "# Refunds\n1. Check the order\n2. Issue the refund", status: "active" });
    expect(input).not.toHaveProperty("status"); // a model cannot ask for anything but a draft
    const p = await create().preview(env.ctx, input);
    expect(p.summary).toContain("Handling a refund");
    expect(await docs(env)).toHaveLength(0);
    const ctx = { ...env.ctx, idempotencyKey: KEY };
    const r1 = await create().run(ctx, input);
    const r2 = await create().run(ctx, input);
    expect(r2.href).toBe(r1.href);
    const rows = await docs(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ title: "Handling a refund", status: "draft", kind: "sop", owner: env.ctx.userId, version: 1 });
    expect(r1.summary).toMatch(/Review it/);
  });

  it("is invisible to another business and refused for viewers", async () => {
    expect(await env.sql`SELECT 1 FROM sops_documents WHERE business_id = ${env.other.businessId}`).toHaveLength(0); // the draft made for business A is not in B
    await expect(create().run(viewer.ctx, { title: "x", body: "y" })).rejects.toMatchObject({ status: 403 });
    expect(await docs(viewer)).toHaveLength(0);
  });
});
