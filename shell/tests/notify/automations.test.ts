import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AttentionItem } from "@founderos/sdk";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { daysUntil, runAutomations, runReminderSweep } from "../../src/lib/notify/automations";
import { buildSystemContext } from "../../src/lib/notify/system-context";
import { NOW, scripted } from "./helpers";

let env: TestEnv;
const items: AttentionItem[] = [
  { id: "compliance-soon-c1", title: "Due soon: Annual report", severity: "review", dueDate: "2026-10-27", href: "/app/t/compliance/c1" },
  { id: "compliance-overdue-c2", title: "Overdue: Business license", severity: "high", dueDate: "2026-10-01" },
  { id: "vault-expiry-d1", title: "Insurance expires soon", severity: "review", dueDate: "2026-10-20" },
  { id: "tasks-t1", title: "Send invoice", severity: "review", dueDate: "2026-10-01" },
  { id: "crm-stale-o1", title: "No activity for 20 days: Acme", severity: "review" },
  { id: "finance-runway", title: "Cash is low", severity: "high" },
  { id: "marketing-soon", title: "Plan campaign", severity: "info", dueDate: "2026-10-12" },
  { id: "marketing-later", title: "Far away", severity: "info", dueDate: "2026-12-30" },
];

beforeAll(async () => { env = await makeTestEnv([scripted(items)]); });
afterAll(async () => { await env.cleanup(); });

const keys = async (businessId: string) => (await env.sql<{ dedupe_key: string }[]>`SELECT dedupe_key FROM notifications WHERE business_id = ${businessId} ORDER BY dedupe_key`).map((r) => r.dedupe_key);

describe("system automations", () => {
  it("counts days between ISO dates", () => {
    expect(daysUntil("2026-10-27", "2026-10-07")).toBe(20);
    expect(daysUntil("2026-10-01", "2026-10-07")).toBe(-6);
  });

  it("fires each rule exactly once, however often the sweep runs", async () => {
    const first = await runReminderSweep(env.sql, env.ctx.businessId, items, { now: NOW, emailEnabled: false });
    expect(first).toEqual({ automations: 5, reminders: 2 });
    const again = await runReminderSweep(env.sql, env.ctx.businessId, items, { now: NOW, emailEnabled: false });
    expect(again).toEqual({ automations: 0, reminders: 0 });
    expect(await keys(env.ctx.businessId)).toEqual([
      "compliance-due-30:compliance-soon-c1:2026-10-27",
      "compliance-overdue:compliance-overdue-c2:2026-10-01",
      "crm-stale:crm-stale-o1:" + Math.floor(Date.parse("2026-10-07T00:00:00Z") / 86_400_000 / 28),
      "document-expiry:14:vault-expiry-d1:2026-10-20",
      "reminder:finance-runway:none",
      "reminder:marketing-soon:2026-10-12",
      "task-overdue:tasks-t1",
    ]);
    // Rules write their own run records, and leave other businesses alone.
    const runs = await env.sql`SELECT 1 FROM automation_runs WHERE business_id = ${env.ctx.businessId}`;
    expect(runs).toHaveLength(5);
    expect(await keys(env.other.businessId)).toEqual([]);
  });

  it("fires the next document-expiry step as the date approaches, once", async () => {
    const later = new Date("2026-10-18T12:00:00Z"); // 2 days before expiry
    const r = await runAutomations(env.sql, env.ctx.businessId, items, { now: later, emailEnabled: false });
    expect(r.fired).toContain("document-expiry:3:vault-expiry-d1:2026-10-20");
    expect((await runAutomations(env.sql, env.ctx.businessId, items, { now: later, emailEnabled: false })).fired).toEqual([]);
  });

  it("builds the system context without a user, without AI, and runs the real attention() pipeline", async () => {
    const ctx = (await buildSystemContext(env.sql, env.other.businessId, [scripted(items)]))!;
    expect(ctx).toMatchObject({ role: "owner", userId: "system", canWrite: true });
    expect(ctx.ai.available).toBe(false);
    expect((await ctx.context()).attention).toHaveLength(items.length);
    expect(await buildSystemContext(env.sql, "00000000-0000-4000-8000-000000000000", [])).toBeNull();
    // ctx.notify writes to the right business and is idempotent.
    await ctx.notify({ title: "hello", dedupeKey: "sys:1" });
    await ctx.notify({ title: "hello", dedupeKey: "sys:1" });
    expect(await keys(env.other.businessId)).toEqual(["sys:1"]);
  });
});
