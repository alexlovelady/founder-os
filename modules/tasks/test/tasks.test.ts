import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolDef } from "@founderos/sdk";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { addInterval, nextDueDate } from "../src/dates";
import { tool } from "../src/index";

// A stand-in for another tool: it resolves one known id so links can be tested without importing a real tool.
const KNOWN = "11111111-1111-4111-8111-111111111111";
const fake: ToolDef = {
  id: "crm", name: "CRM", description: "", group: "growth", status: "live",
  resolve: async (_ctx, id) => (id === KNOWN ? { title: "Acme Corp", href: "/app/t/crm/x" } : null),
};

describe("recurrence dates", () => {
  it("adds intervals and clamps month ends", () => {
    expect(addInterval("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(addInterval("2026-11-30", "quarterly")).toBe("2027-02-28");
    expect(addInterval("2028-02-29", "yearly")).toBe("2029-02-28");
    expect(addInterval("2026-12-28", "weekly")).toBe("2027-01-04");
  });
  it("skips dates already in the past", () => {
    expect(nextDueDate("2026-01-01", "weekly", "2026-01-20")).toBe("2026-01-22");
    expect(nextDueDate(null, "monthly", "2026-03-31")).toBe("2026-04-30");
  });
});

describe("tasks tool (database)", () => {
  let env: TestEnv;
  let today: string;
  const day = async (offset: number) => {
    const [r] = await env.sql<{ d: string }[]>`SELECT to_char(current_date + ${offset}::int, 'YYYY-MM-DD') AS d`;
    return r.d;
  };
  beforeAll(async () => {
    env = await makeTestEnv([tool, fake]);
    today = await day(0);
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("creates, lists, updates and deletes", async () => {
    const c = await call(tool, env.ctx, "POST", "items", { title: "  File annual report ", dueDate: await day(10), priority: "high" });
    expect(c.status).toBe(201);
    expect(c.data.task).toMatchObject({ title: "File annual report", priority: "high", status: "todo", source: "manual", recurrence: "none", dueDate: await day(10) });
    const id = c.data.task.id;
    const p = await call(tool, env.ctx, "PATCH", `items/${id}`, { title: "File annual report 2026", status: "in_progress", assignedTo: env.ctx.userId });
    expect(p.data.task).toMatchObject({ title: "File annual report 2026", status: "in_progress", assignedTo: env.ctx.userId });
    expect((await call(tool, env.ctx, "GET", `items/${id}`)).data.task.id).toBe(id);
    const mine = await call(tool, env.ctx, "GET", "items?mine=1");
    expect(mine.data.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
    const del = await call(tool, env.ctx, "DELETE", `items/${id}`);
    expect(del.status).toBe(200);
    expect((await call(tool, env.ctx, "GET", `items/${id}`)).status).toBe(404);
  });

  it("validates input", async () => {
    expect((await call(tool, env.ctx, "POST", "items", { title: "  " })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "items", { title: "x", priority: "urgent" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "items", { title: "x", dueDate: "2026-02-31" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "items", { title: "x", recurrence: "daily" })).status).toBe(400);
    expect((await call(tool, env.ctx, "PATCH", "items/not-a-uuid", { title: "x" })).status).toBe(404);
    const t = (await call(tool, env.ctx, "POST", "items", { title: "v" })).data.task;
    expect((await call(tool, env.ctx, "PATCH", `items/${t.id}`, {})).status).toBe(400);
    expect((await call(tool, env.ctx, "GET", "items?status=bogus")).status).toBe(400);
  });

  it("filters by status, due window and source", async () => {
    const mk = (b: object) => call(tool, env.ctx, "POST", "items", b);
    const over = (await mk({ title: "F overdue", dueDate: await day(-2) })).data.task;
    const tod = (await mk({ title: "F today", dueDate: today })).data.task;
    const later = (await mk({ title: "F later", dueDate: await day(30) })).data.task;
    const none = (await mk({ title: "F nodate" })).data.task;
    const ids = async (qs: string) => (await call(tool, env.ctx, "GET", `items?${qs}`)).data.tasks.map((t: { id: string }) => t.id);
    expect(await ids("due=overdue")).toContain(over.id);
    expect(await ids("due=overdue")).not.toContain(tod.id);
    expect(await ids("due=today")).toEqual([tod.id]);
    expect(await ids("due=upcoming")).toContain(later.id);
    expect(await ids("due=none")).toContain(none.id);
    expect(await ids(`dueFrom=${await day(20)}&dueTo=${await day(40)}`)).toEqual([later.id]);
    await call(tool, env.ctx, "POST", `items/${tod.id}/complete`);
    expect(await ids("status=done")).toEqual([tod.id]);
    expect(await ids("status=open")).not.toContain(tod.id);
    expect(await ids("source=manual")).toContain(over.id);
    expect(await ids("source=crm")).toEqual([]);
  });

  it("completing a recurring task creates the next one, once", async () => {
    const t = (await call(tool, env.ctx, "POST", "items", { title: "Quarterly estimated tax", dueDate: await day(-1), recurrence: "quarterly", priority: "high" })).data.task;
    const done = await call(tool, env.ctx, "POST", `items/${t.id}/complete`);
    expect(done.data.task).toMatchObject({ status: "done" });
    expect(done.data.task.completedAt).toBeTruthy();
    expect(done.data.next).toMatchObject({ title: "Quarterly estimated tax", status: "todo", priority: "high", recurrence: "quarterly", dueDate: nextDueDate(await day(-1), "quarterly", today) });
    expect(done.data.next.dueDate > today).toBe(true);
    const again = await call(tool, env.ctx, "POST", `items/${t.id}/complete`);
    expect(again.data.next).toBeNull();
    const list = (await call(tool, env.ctx, "GET", "items?status=open")).data.tasks.filter((x: { title: string }) => x.title === "Quarterly estimated tax");
    expect(list).toHaveLength(1);
    // Reopening clears completed_at.
    const re = await call(tool, env.ctx, "PATCH", `items/${t.id}`, { status: "todo" });
    expect(re.data.task.completedAt).toBeNull();
    // Non-recurring tasks create nothing.
    const one = (await call(tool, env.ctx, "POST", "items", { title: "One-off" })).data.task;
    expect((await call(tool, env.ctx, "POST", `items/${one.id}/complete`)).data.next).toBeNull();
  });

  it("from-source creates tasks from other tools, links when it can, and is idempotent", async () => {
    const r = await call(tool, env.ctx, "POST", "from-source", { title: "Call Acme about renewal", dueDate: await day(5), priority: "high", source: "crm", sourceRef: { tool: "crm", id: KNOWN } });
    expect(r.status).toBe(201);
    expect(r.data.task).toMatchObject({ source: "crm", sourceRef: { tool: "crm", id: KNOWN }, priority: "high" });
    const linked = await env.ctx.links.list({ tool: "tasks", id: r.data.task.id });
    expect(linked[0]).toMatchObject({ tool: "crm", title: "Acme Corp" });
    const again = await call(tool, env.ctx, "POST", "from-source", { title: "Call Acme about renewal", source: "crm", sourceRef: { tool: "crm", id: KNOWN } });
    expect(again.status).toBe(200);
    expect(again.data.task.id).toBe(r.data.task.id);
    // Unresolvable refs and unknown tools still create the task.
    const odd = await call(tool, env.ctx, "POST", "from-source", { title: "Ghost ref", source: "document", sourceRef: { tool: "nosuchtool", id: "abc" } });
    expect(odd.status).toBe(201);
    expect(await env.ctx.links.list({ tool: "tasks", id: odd.data.task.id })).toEqual([]);
    // Bulk, no ref.
    const bulk = await call(tool, env.ctx, "POST", "from-source", { tasks: [{ title: "A", source: "ai" }, { title: "B", source: "system", dueDate: today }] });
    expect(bulk.data.tasks).toHaveLength(2);
    expect(bulk.data.tasks[1]).toMatchObject({ source: "system", dueDate: today });
    // Shape checks.
    expect((await call(tool, env.ctx, "POST", "from-source", { title: "x", source: "manual" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "from-source", { title: "x", source: "crm", sourceRef: { tool: "CRM!", id: "1" } })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "from-source", { title: "x", source: "crm", sourceRef: { tool: "crm" } })).status).toBe(400);
    const bySrc = await call(tool, env.ctx, "GET", `items?sourceTool=crm&sourceId=${KNOWN}`);
    expect(bySrc.data.tasks).toHaveLength(1);
  });

  it("isolates businesses", async () => {
    const mine = (await call(tool, env.ctx, "POST", "items", { title: "Secret plan", dueDate: await day(-3) })).data.task;
    expect((await call(tool, env.other, "GET", "items")).data.tasks).toEqual([]);
    expect((await call(tool, env.other, "GET", `items/${mine.id}`)).status).toBe(404);
    expect((await call(tool, env.other, "PATCH", `items/${mine.id}`, { title: "hacked" })).status).toBe(404);
    expect((await call(tool, env.other, "POST", `items/${mine.id}/complete`)).status).toBe(404);
    expect((await call(tool, env.other, "DELETE", `items/${mine.id}`)).status).toBe(404);
    expect(await tool.resolve!(env.other, mine.id)).toBeNull();
    expect(await tool.search!(env.other, "Secret", 5)).toEqual([]);
    expect(await tool.attention!(env.other)).toEqual([]);
    expect(await tool.facts!(env.other)).toEqual({ open: 0, overdue: 0, dueThisWeek: 0, completedLast30Days: 0 });
    expect(await tool.describe!(env.other)).toBe("");
    // Another business cannot link to my task.
    await expect(env.other.links.add({ tool: "tasks", id: mine.id }, { tool: "tasks", id: mine.id })).rejects.toThrow();
  });

  it("viewers can read but not change", async () => {
    const viewer = await makeTestEnv([tool, fake], { role: "viewer" });
    try {
      expect((await call(tool, viewer.ctx, "POST", "items", { title: "n" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "POST", "from-source", { title: "n", source: "ai" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "GET", "items")).status).toBe(200);
      const t = (await call(tool, env.ctx, "POST", "items", { title: "x" })).data.task;
      expect((await call(tool, viewer.ctx, "PATCH", `items/${t.id}`, { title: "y" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "DELETE", `items/${t.id}`)).status).toBe(403);
    } finally {
      await viewer.cleanup();
    }
  });

  it("publishes facts, describe, attention, resolve and search", async () => {
    const f = (await tool.facts!(env.ctx)) as Record<string, number>;
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM tasks_items WHERE business_id = ${env.ctx.businessId} AND status <> 'done'`;
    expect(f.open).toBe(n);
    expect(f.overdue).toBeGreaterThanOrEqual(2);
    expect(f.dueThisWeek).toBeGreaterThanOrEqual(1);
    expect(f.completedLast30Days).toBeGreaterThanOrEqual(2);
    const d = await tool.describe!(env.ctx);
    expect(d).toMatch(/open task/);
    expect(d).toMatch(/overdue/);
    expect(d.length).toBeLessThanOrEqual(600);

    const att = await tool.attention!(env.ctx);
    expect(att.length).toBeGreaterThan(0);
    expect(att.length).toBeLessThanOrEqual(10);
    const overdueItem = att.find((a) => a.title === "F overdue")!;
    expect(overdueItem).toMatchObject({ severity: "review", dueDate: await day(-2) });
    expect(overdueItem.detail).toMatch(/Overdue by 2 days/);
    const hi = (await call(tool, env.ctx, "POST", "items", { title: "High overdue", priority: "high", dueDate: await day(-1) })).data.task;
    const soon = (await call(tool, env.ctx, "POST", "items", { title: "Soon high", priority: "high", dueDate: await day(2) })).data.task;
    const att2 = await tool.attention!(env.ctx);
    expect(att2.find((a) => a.id === `tasks-${hi.id}`)?.severity).toBe("high");
    expect(att2.find((a) => a.id === `tasks-${soon.id}`)?.severity).toBe("review");
    expect(att2.find((a) => a.title === "Ghost ref")).toBeUndefined();

    expect(await tool.resolve!(env.ctx, hi.id)).toEqual({ title: "High overdue", href: `/app/t/tasks/t/${hi.id}` });
    expect(await tool.resolve!(env.ctx, "nope")).toBeNull();
    const hits = await tool.search!(env.ctx, "high overdue", 5);
    expect(hits[0]).toMatchObject({ id: hi.id, title: "High overdue" });
    expect((await env.ctx.search("high overdue")).some((g) => g.tool === "tasks")).toBe(true);
    const bc = await env.ctx.context();
    expect(bc.summaries.tasks).toMatch(/open task/);
  });
});

import { normalizeFromSource } from "../src/normalize";

describe("from-source accepts the shapes other tools send", () => {
  it("derives source from the referencing tool", () => {
    expect(normalizeFromSource({ title: "Follow up", sourceRef: { tool: "crm", id: "1" } })).toMatchObject({ source: "crm", sourceRef: { tool: "crm", id: "1" } });
    expect(normalizeFromSource({ title: "x", sourceRef: { tool: "vault", id: "1" } })).toMatchObject({ source: "document" });
  });
  it("turns a source object with items into one task per item", () => {
    const r = normalizeFromSource({ source: { tool: "sops", id: "d1" }, title: "Onboarding", items: [{ title: "Step 1" }, { title: "Step 2" }] }) as { tasks: Record<string, unknown>[] };
    expect(r.tasks.map((t) => t.title)).toEqual(["Step 1", "Step 2"]);
    expect(r.tasks[0]).toMatchObject({ source: "document", sourceRef: { tool: "sops", id: "d1" }, description: "From: Onboarding" });
  });
});
