import type { AttentionItem, NotifyInput, Sql } from "@founderos/sdk";
import { createNotification } from "./index";

/**
 * System automations (spec 32): rules the platform creates for every business. They work only from attention() items (id, title, dueDate,
 * severity), so tools stay independent: a rule recognises "its" items by the tool id every attention id starts with ("compliance-...").
 * Each (business, rule, key) fires at most once, recorded in automation_runs. User-defined workflows are future work.
 */
export interface AutomationRule {
  id: string;
  description: string;
  /** Returns null when the item is not this rule's business; otherwise the once-only key and the notification to send. */
  evaluate(item: AttentionItem, today: string): { key: string; notify: NotifyInput } | null;
}

const DAY = 86_400_000;
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
/** Whole days from `today` to `date` (negative = in the past). Both are YYYY-MM-DD. */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(date.slice(0, 10) + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / DAY);
}
const plural = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
const keyOf = (item: AttentionItem) => `${item.id}:${item.dueDate ?? "none"}`;

export const DOC_EXPIRY_MILESTONES = [30, 14, 3] as const;
export const CRM_STALE_BUCKET_DAYS = 28;

export const RULES: AutomationRule[] = [
  {
    id: "compliance-due-30",
    description: "30 days before a compliance item is due: notify once.",
    evaluate(item, today) {
      if (!item.id.startsWith("compliance-") || !item.dueDate) return null;
      const d = daysUntil(item.dueDate, today);
      if (d < 0 || d > 30) return null;
      return { key: keyOf(item), notify: { title: `${item.title} (due in ${plural(d)})`, body: item.detail, href: item.href, severity: item.severity } };
    },
  },
  {
    id: "compliance-overdue",
    description: "A compliance item becomes overdue: notify once.",
    evaluate(item, today) {
      if (!item.id.startsWith("compliance-") || !item.dueDate) return null;
      const d = daysUntil(item.dueDate, today);
      if (d >= 0) return null;
      return { key: keyOf(item), notify: { title: `${item.title} (${plural(-d)} overdue)`, body: item.detail, href: item.href, severity: "high" } };
    },
  },
  {
    id: "document-expiry",
    description: "A document expires in 30, 14 and 3 days: one notification at each step.",
    evaluate(item, today) {
      if (!item.id.startsWith("vault-expiry-") || !item.dueDate) return null;
      const d = daysUntil(item.dueDate, today);
      if (d < 0) return null;
      const step = [...DOC_EXPIRY_MILESTONES].reverse().find((m) => d <= m);
      if (step === undefined) return null;
      return { key: `${step}:${keyOf(item)}`, notify: { title: `${item.title} (in ${plural(d)})`, body: item.detail, href: item.href, severity: d <= 14 ? "high" : "review" } };
    },
  },
  {
    id: "document-expired",
    description: "A document has expired: notify once.",
    evaluate(item, today) {
      if (!item.id.startsWith("vault-expiry-") || !item.dueDate) return null;
      if (daysUntil(item.dueDate, today) >= 0) return null;
      return { key: keyOf(item), notify: { title: item.title, body: item.detail, href: item.href, severity: "high" } };
    },
  },
  {
    id: "task-overdue",
    description: "A task becomes overdue: notify once per task.",
    evaluate(item, today) {
      if (!item.id.startsWith("tasks-") || !item.dueDate) return null;
      const d = daysUntil(item.dueDate, today);
      if (d >= 0) return null;
      return { key: item.id, notify: { title: `Overdue task: ${item.title}`, body: item.detail, href: item.href, severity: item.severity === "high" ? "high" : "review" } };
    },
  },
  {
    id: "crm-stale",
    description: "An open CRM opportunity has had no activity (the CRM's own stale threshold, 14 days by default): notify, at most once every 28 days.",
    evaluate(item, today) {
      if (!item.id.startsWith("crm-stale-")) return null;
      const bucket = Math.floor(Date.parse(today + "T00:00:00Z") / DAY / CRM_STALE_BUCKET_DAYS);
      return { key: `${item.id}:${bucket}`, notify: { title: item.title, body: item.detail, href: item.href, severity: "review" } };
    },
  },
];

export interface AutomationResult {
  fired: string[];
  /** Ids of items a rule recognised (fired now or earlier), so the generic reminder sweep leaves them alone. */
  claimed: Set<string>;
}

export async function runAutomations(
  sql: Sql,
  businessId: string,
  items: AttentionItem[],
  opts: { now?: Date; emailEnabled?: boolean; rules?: AutomationRule[] } = {},
): Promise<AutomationResult> {
  const today = isoDate(opts.now ?? new Date());
  const result: AutomationResult = { fired: [], claimed: new Set() };
  for (const item of items) {
    for (const rule of opts.rules ?? RULES) {
      const hit = rule.evaluate(item, today);
      if (!hit) continue;
      result.claimed.add(item.id);
      // The run record and the notification commit together, so a failure is retried on the next sweep instead of being lost.
      await sql.begin(async (tx) => {
        const ins = await tx`INSERT INTO automation_runs (business_id, rule, key) VALUES (${businessId}, ${rule.id}, ${hit.key}) ON CONFLICT DO NOTHING RETURNING id`;
        if (!ins.length) return;
        await createNotification(tx as unknown as Sql, businessId, { ...hit.notify, dedupeKey: `${rule.id}:${hit.key}` }, { emailEnabled: opts.emailEnabled });
        result.fired.push(`${rule.id}:${hit.key}`);
      });
    }
  }
  return result;
}

export const REMINDER_WINDOW_DAYS = 14;

/**
 * The daily reminder sweep for one business: system rules first, then a generic reminder for any other attention item that is due within
 * 14 days (or already late) or has severity "high". Both are idempotent.
 */
export async function runReminderSweep(
  sql: Sql,
  businessId: string,
  items: AttentionItem[],
  opts: { now?: Date; emailEnabled?: boolean } = {},
): Promise<{ automations: number; reminders: number }> {
  const today = isoDate(opts.now ?? new Date());
  const auto = await runAutomations(sql, businessId, items, opts);
  let reminders = 0;
  for (const item of items) {
    if (auto.claimed.has(item.id)) continue;
    const due = item.dueDate && daysUntil(item.dueDate, today) <= REMINDER_WINDOW_DAYS;
    if (!due && item.severity !== "high") continue;
    const r = await createNotification(
      sql,
      businessId,
      { title: item.title, body: item.detail, href: item.href, severity: item.severity, dedupeKey: `reminder:${keyOf(item)}` },
      { emailEnabled: opts.emailEnabled },
    );
    if (r.created) reminders++;
  }
  return { automations: auto.fired.length, reminders };
}
