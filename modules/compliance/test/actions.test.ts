import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolAction } from "@founderos/sdk";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";

const action = (id: string): ToolAction => tool.actions!.find((a) => a.id === id)!;
const KEY = "fp:comp-key-1";
const NOPE = "00000000-0000-4000-8000-000000000000";

describe("compliance actions (assistant proposals)", () => {
  let env: TestEnv;
  let viewer: TestEnv;
  let itemId: string;
  const row = async (id: string) => (await env.sql`SELECT status, to_char(due_date, 'YYYY-MM-DD') AS due, notes FROM compliance_items WHERE id = ${id}`)[0];
  const count = async () => (await env.sql`SELECT count(*)::int AS n FROM compliance_items WHERE business_id = ${env.ctx.businessId}`)[0].n as number;

  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    viewer = await makeTestEnv([tool], { role: "viewer" });
    itemId = (await call(tool, env.ctx, "POST", "items", { title: "Annual report", dueDate: "2027-04-01" })).data.item.id;
  });
  afterAll(async () => {
    await env.cleanup();
    await viewer.cleanup();
  });

  it("declares the proposed actions", () => {
    expect(tool.actions!.map((a) => a.id)).toEqual(["mark_item_complete", "set_item_due_date", "add_custom_item"]);
  });

  it("mark_item_complete: preview is read-only and warns it is not verified; run completes; repeat is harmless", async () => {
    const a = action("mark_item_complete");
    const p = await a.preview(env.ctx, { itemId });
    expect(p.summary).toContain("Annual report");
    expect(p.details!.Note).toMatch(/does not check/);
    expect((await row(itemId)).status).toBe("missing");
    const ctx = { ...env.ctx, idempotencyKey: KEY };
    await a.run(ctx, { itemId });
    await a.run(ctx, { itemId });
    expect((await row(itemId)).status).toBe("complete");
    expect((await a.preview(env.ctx, { itemId })).summary).toMatch(/already complete/);
  });

  it("set_item_due_date: validates the date, shows old and new, changes only the date", async () => {
    const a = action("set_item_due_date");
    expect(a.input.safeParse({ itemId, dueDate: "2027-02-30" }).success).toBe(false);
    expect(a.input.safeParse({ itemId: "x", dueDate: "2027-02-01" }).success).toBe(false);
    const p = await a.preview(env.ctx, { itemId, dueDate: "2027-05-01" });
    expect(p.details).toMatchObject({ "Old due date": "2027-04-01", "New due date": "2027-05-01" });
    expect((await row(itemId)).due).toBe("2027-04-01");
    await a.run(env.ctx, { itemId, dueDate: "2027-05-01" });
    await a.run(env.ctx, { itemId, dueDate: "2027-05-01" });
    expect(await row(itemId)).toMatchObject({ due: "2027-05-01", status: "complete" });
  });

  it("add_custom_item: preview is read-only, run adds one item per key, validation applies", async () => {
    const a = action("add_custom_item");
    expect(a.input.safeParse({ title: "" }).success).toBe(false);
    expect(a.input.safeParse({ title: "x", category: "nonsense" }).success).toBe(false);
    const input = a.input.parse({ title: "Renew food permit", dueDate: "2027-08-01", description: "County permit" });
    const before = await count();
    expect((await a.preview(env.ctx, input)).summary).toContain("Renew food permit");
    expect(await count()).toBe(before);
    const ctx = { ...env.ctx, idempotencyKey: KEY };
    const r1 = await a.run(ctx, input);
    const r2 = await a.run(ctx, input);
    expect(r2.href).toBe(r1.href);
    expect(await count()).toBe(before + 1);
    const created = await row(r1.href!.split("/").pop()!);
    expect(created).toMatchObject({ status: "missing", due: "2027-08-01" });
    expect(created.notes).toContain("Ask FounderOS");
  });

  it("never touches another business's records", async () => {
    for (const [aid, input] of [["mark_item_complete", { itemId }], ["set_item_due_date", { itemId, dueDate: "2027-09-09" }]] as const) {
      await expect(action(aid).preview(env.other, input)).rejects.toMatchObject({ status: 404 });
      await expect(action(aid).run(env.other, input)).rejects.toMatchObject({ status: 404 });
    }
    expect((await row(itemId)).due).toBe("2027-05-01");
    await expect(action("mark_item_complete").preview(env.ctx, { itemId: NOPE })).rejects.toMatchObject({ status: 404 });
  });

  it("viewers cannot run any action", async () => {
    for (const [aid, input] of [["mark_item_complete", { itemId: NOPE }], ["set_item_due_date", { itemId: NOPE, dueDate: "2027-01-01" }], ["add_custom_item", { title: "x" }]] as const) {
      await expect(action(aid).run(viewer.ctx, input)).rejects.toMatchObject({ status: 403 });
    }
  });
});
