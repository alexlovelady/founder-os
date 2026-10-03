import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolAction } from "@founderos/sdk";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";

const action = (id: string): ToolAction => tool.actions!.find((a) => a.id === id)!;
const KEY = "fp:test-key-1";
const NOPE = "00000000-0000-4000-8000-000000000000";

describe("tasks actions (assistant proposals)", () => {
  let env: TestEnv;
  let viewer: TestEnv;
  const count = async (e: TestEnv) => (await e.sql`SELECT count(*)::int AS n FROM tasks_items WHERE business_id = ${e.ctx.businessId}`)[0].n as number;
  const mk = async (title: string, extra: Record<string, unknown> = {}) => {
    const [r] = await env.sql<{ id: string }[]>`
      INSERT INTO tasks_items (business_id, title, created_by, due_date, recurrence) VALUES (${env.ctx.businessId}, ${title}, 'u', ${(extra.due as string) ?? null}, ${(extra.recurrence as string) ?? "none"}) RETURNING id`;
    return r.id;
  };

  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    viewer = await makeTestEnv([tool], { role: "viewer" });
  });
  afterAll(async () => {
    await env.cleanup();
    await viewer.cleanup();
  });

  it("declares exactly the proposed actions, none destructive", () => {
    expect(tool.actions!.map((a) => a.id)).toEqual(["create_task", "complete_task", "reschedule_task"]);
    for (const a of tool.actions!) expect(a.id).not.toMatch(/delete|remove/);
  });

  it("create_task: preview has no side effects, run creates an AI-sourced task, and the same key is idempotent", async () => {
    const a = action("create_task");
    const input = a.input.parse({ title: "Renew business license", dueDate: "2027-01-15", priority: "high" });
    const before = await count(env);
    const p = await a.preview(env.ctx, input);
    expect(p.summary).toContain("Renew business license");
    expect(await count(env)).toBe(before);

    const ctx = { ...env.ctx, idempotencyKey: KEY };
    const r1 = await a.run(ctx, input);
    const r2 = await a.run(ctx, input);
    expect(r2.href).toBe(r1.href);
    expect(await count(env)).toBe(before + 1);
    const [row] = await env.sql`SELECT title, priority, source, to_char(due_date, 'YYYY-MM-DD') AS due FROM tasks_items WHERE id = ${r1.href!.split("/").pop()!}`;
    expect(row).toMatchObject({ title: "Renew business license", priority: "high", source: "ai", due: "2027-01-15" });
  });

  it("validates input", () => {
    expect(action("create_task").input.safeParse({ title: "  " }).success).toBe(false);
    expect(action("create_task").input.safeParse({ title: "x", dueDate: "2026-02-31" }).success).toBe(false);
    expect(action("create_task").input.safeParse({ title: "x", priority: "urgent" }).success).toBe(false);
    expect(action("complete_task").input.safeParse({ taskId: "nope" }).success).toBe(false);
    expect(action("reschedule_task").input.safeParse({ taskId: NOPE, dueDate: "soon" }).success).toBe(false);
  });

  it("complete_task: preview is read-only, run completes (once), and a recurring task spawns its next one", async () => {
    const a = action("complete_task");
    const id = await mk("Send invoices");
    const p = await a.preview(env.ctx, { taskId: id });
    expect(p.summary).toContain("Send invoices");
    expect((await env.sql`SELECT status FROM tasks_items WHERE id = ${id}`)[0].status).toBe("todo");
    const ctx = { ...env.ctx, idempotencyKey: KEY };
    await a.run(ctx, { taskId: id });
    await a.run(ctx, { taskId: id });
    expect((await env.sql`SELECT status FROM tasks_items WHERE id = ${id}`)[0].status).toBe("done");
    expect((await a.preview(env.ctx, { taskId: id })).summary).toMatch(/already done/);

    const rid = await mk("Weekly review", { recurrence: "weekly", due: "2026-12-01" });
    await a.run(ctx, { taskId: rid });
    await a.run(ctx, { taskId: rid });
    const n = await env.sql`SELECT count(*)::int AS n FROM tasks_items WHERE business_id = ${env.ctx.businessId} AND title = 'Weekly review'`;
    expect(n[0].n).toBe(2); // the original (done) and exactly one next occurrence
  });

  it("reschedule_task: shows old and new date, then changes only the date", async () => {
    const a = action("reschedule_task");
    const id = await mk("File report", { due: "2027-03-01" });
    const p = await a.preview(env.ctx, { taskId: id, dueDate: "2027-03-15" });
    expect(p.details).toMatchObject({ "Old due date": "2027-03-01", "New due date": "2027-03-15" });
    expect((await env.sql`SELECT to_char(due_date, 'YYYY-MM-DD') AS d FROM tasks_items WHERE id = ${id}`)[0].d).toBe("2027-03-01");
    await a.run(env.ctx, { taskId: id, dueDate: "2027-03-15" });
    const [row] = await env.sql`SELECT title, status, to_char(due_date, 'YYYY-MM-DD') AS d FROM tasks_items WHERE id = ${id}`;
    expect(row).toMatchObject({ title: "File report", status: "todo", d: "2027-03-15" });
  });

  it("never touches another business's records (preview and run both 404)", async () => {
    const id = await mk("Mine only");
    for (const [aid, input] of [["complete_task", { taskId: id }], ["reschedule_task", { taskId: id, dueDate: "2027-05-05" }]] as const) {
      await expect(action(aid).preview(env.other, input)).rejects.toMatchObject({ status: 404 });
      await expect(action(aid).run(env.other, input)).rejects.toMatchObject({ status: 404 });
    }
    expect((await env.sql`SELECT status, to_char(due_date, 'YYYY-MM-DD') AS d FROM tasks_items WHERE id = ${id}`)[0]).toMatchObject({ status: "todo", d: null });
    await expect(action("complete_task").preview(env.ctx, { taskId: NOPE })).rejects.toMatchObject({ status: 404 });
  });

  it("viewers cannot run any action", async () => {
    for (const [aid, input] of [["create_task", { title: "x" }], ["complete_task", { taskId: NOPE }], ["reschedule_task", { taskId: NOPE, dueDate: "2027-01-01" }]] as const) {
      await expect(action(aid).run(viewer.ctx, input)).rejects.toMatchObject({ status: 403 });
    }
    expect(await count(viewer)).toBe(0);
  });
});
