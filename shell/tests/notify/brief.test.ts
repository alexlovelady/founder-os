import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AttentionItem } from "@founderos/sdk";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { buildBriefMarkdown, generateBriefForBusiness, latestBrief, setBriefEnabledHook, weekStartOf } from "../../src/lib/notify/brief";
import { setPreferences } from "../../src/lib/notify";
import { NOW, scripted } from "./helpers";

const items: AttentionItem[] = [
  { id: "finance-info", title: "Check runway", severity: "info" },
  { id: "tasks-1", title: "Send invoice", detail: "Overdue by 6 days", severity: "review", dueDate: "2026-10-01" },
  { id: "compliance-soon-1", title: "Due soon: Annual report", severity: "review", dueDate: "2026-10-20" },
  { id: "vault-expiry-1", title: "Insurance has expired", severity: "high", dueDate: "2026-09-30" },
  { id: "crm-2", title: "Follow up with Acme", severity: "review" },
];

let env: TestEnv;
beforeAll(async () => { env = await makeTestEnv([scripted(items, "4 open tasks, 1 overdue.", "tasks", "Tasks"), scripted([], "2 contacts.", "crm", "CRM")]); });
afterAll(async () => { setBriefEnabledHook(() => true); await env.cleanup(); });

describe("weekly brief", () => {
  it("finds the Monday of the week", () => {
    expect(weekStartOf(NOW)).toBe("2026-10-07".replace("07", "05"));
    expect(weekStartOf(new Date("2026-10-11T23:59:00Z"))).toBe("2026-10-05"); // Sunday
    expect(weekStartOf(new Date("2026-10-12T00:00:00Z"))).toBe("2026-10-12");
  });

  it("is deterministic and built from the data", () => {
    const input = { businessName: "Acme", weekStart: "2026-10-05", today: "2026-10-07", attention: items, summaries: { tasks: "4 open tasks.", crm: "2 contacts." }, toolNames: { tasks: "Tasks", crm: "CRM" } };
    const md = buildBriefMarkdown(input);
    expect(md).toBe(buildBriefMarkdown(input));
    expect(md).toContain("## Needs attention");
    expect(md).toContain("Insurance has expired (7 days overdue)");
    expect(md).toContain("- Due soon: Annual report on 2026-10-20");
    expect(md).toContain("1 overdue task");
    expect(md).toContain("- Tasks: 4 open tasks.");
    // Top 3 by severity, high first, then earliest due date.
    const rec = md.split("## Recommended next actions\n")[1].split("\n");
    expect(rec[0]).toMatch(/^1\. Insurance has expired/);
    expect(rec[1]).toMatch(/^2\. Send invoice/);
    expect(rec[2]).toMatch(/^3\. Due soon: Annual report/);
  });

  it("is created once per week, with an in-app notice, and read back", async () => {
    expect(await generateBriefForBusiness(env.sql, env.ctx.businessId, { now: NOW, tools: [scripted(items, "4 open tasks.", "tasks", "Tasks")], emailEnabled: false })).toBe(true);
    expect(await generateBriefForBusiness(env.sql, env.ctx.businessId, { now: NOW, tools: [scripted(items)], emailEnabled: false })).toBe(false);
    const b = await latestBrief(env.sql, env.ctx.businessId);
    expect(b?.weekStart).toBe("2026-10-05");
    expect(b?.contentMd).toContain("Test Co A");
    const n = await env.sql`SELECT 1 FROM notifications WHERE business_id = ${env.ctx.businessId} AND dedupe_key = 'weekly-brief:2026-10-05'`;
    expect(n).toHaveLength(1);
    expect(await latestBrief(env.sql, env.other.businessId)).toBeNull();
  });

  it("emails only opted-in members, and only when email is enabled", async () => {
    await setPreferences(env.sql, env.ctx.businessId, env.ctx.userId, { inApp: true, email: true, weeklyBrief: true, quietTypes: [] }, "owner@example.test");
    const next = new Date("2026-10-14T12:00:00Z");
    expect(await generateBriefForBusiness(env.sql, env.ctx.businessId, { now: next, tools: [scripted(items)], emailEnabled: true })).toBe(true);
    const mails = await env.sql<{ subject: string }[]>`SELECT subject FROM email_outbox WHERE business_id = ${env.ctx.businessId}`;
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toContain("weekly business brief");
    // Email off at platform level: brief exists, nothing queued.
    const week3 = new Date("2026-10-21T12:00:00Z");
    expect(await generateBriefForBusiness(env.sql, env.ctx.businessId, { now: week3, tools: [scripted(items)], emailEnabled: false })).toBe(true);
    expect(await env.sql`SELECT 1 FROM email_outbox WHERE business_id = ${env.ctx.businessId}`).toHaveLength(1);
  });

  it("is skipped when the plan hook says no", async () => {
    setBriefEnabledHook(async () => false);
    expect(await generateBriefForBusiness(env.sql, env.other.businessId, { now: NOW, tools: [scripted(items)], emailEnabled: false })).toBe(false);
    setBriefEnabledHook(() => true);
    expect(await generateBriefForBusiness(env.sql, env.other.businessId, { now: NOW, tools: [scripted(items)], emailEnabled: false })).toBe(true);
  });
});
