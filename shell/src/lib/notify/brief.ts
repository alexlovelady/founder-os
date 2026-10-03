import type { AttentionItem, Sql, ToolDef } from "@founderos/sdk";
import { daysUntil, isoDate } from "./automations";
import { enqueueEmail, getEmailProvider, renderBriefEmail } from "./email";
import { briefEnabled } from "./hooks";
import { createNotification } from "./index";
import { emailRecipients } from "./preferences";
import { buildSystemContext } from "./system-context";

export { briefEnabled, setBriefEnabledHook } from "./hooks";

const SEVERITY = { high: 0, review: 1, info: 2 } as const;
const bySeverityThenDue = (a: AttentionItem, b: AttentionItem) =>
  SEVERITY[a.severity] - SEVERITY[b.severity] || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The Monday (UTC) of the week containing `d`, as YYYY-MM-DD. */
export function weekStartOf(d: Date): string {
  const day = (d.getUTCDay() + 6) % 7;
  return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)));
}

export interface BriefInput {
  businessName: string;
  weekStart: string;
  today: string;
  attention: AttentionItem[];
  /** One line per tool from describe(), keyed by tool id. */
  summaries: Record<string, string>;
  toolNames: Record<string, string>;
}

const line = (i: AttentionItem, today: string) => {
  const d = i.dueDate ? daysUntil(i.dueDate, today) : null;
  const when = d === null ? "" : d < 0 ? ` (${plural(-d, "day")} overdue)` : d === 0 ? " (due today)" : ` (due in ${plural(d, "day")})`;
  return `${clean(i.title)}${when}`;
};

/** A deterministic brief from real data: no AI, the same input always gives the same text. */
export function buildBriefMarkdown(input: BriefInput): string {
  const { today } = input;
  const items = [...input.attention].sort(bySeverityThenDue);
  const out: string[] = [`# Your weekly business brief`, `${clean(input.businessName)}, week of ${input.weekStart}`, ""];

  out.push("## Needs attention");
  if (items.length === 0) out.push("Nothing needs your attention right now.");
  else {
    for (const i of items.slice(0, 8)) out.push(`- ${line(i, today)}`);
    if (items.length > 8) out.push(`- ...and ${items.length - 8} more in the app`);
  }

  const dated = items.filter((i) => i.dueDate);
  const overdue = dated.filter((i) => daysUntil(i.dueDate!, today) < 0);
  const upcoming = dated.filter((i) => { const d = daysUntil(i.dueDate!, today); return d >= 0 && d <= 14; }).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));

  out.push("", "## Upcoming deadlines (next 14 days)");
  if (upcoming.length === 0) out.push("No deadlines in the next 14 days.");
  else for (const i of upcoming.slice(0, 8)) out.push(`- ${clean(i.title)} on ${i.dueDate}`);

  out.push("", "## Overdue");
  if (overdue.length === 0) out.push("Nothing is overdue.");
  else {
    const tasks = overdue.filter((i) => i.id.startsWith("tasks-")).length;
    if (tasks) out.push(`- ${plural(tasks, "overdue task")}`);
    for (const i of overdue.slice(0, 8)) out.push(`- ${line(i, today)}`);
  }

  const summaries = Object.entries(input.summaries).filter(([, t]) => t.trim());
  if (summaries.length) {
    out.push("", "## Across your tools");
    for (const [id, text] of summaries) out.push(`- ${input.toolNames[id] ?? id}: ${clean(text).slice(0, 300)}`);
  }

  out.push("", "## Recommended next actions");
  const top = items.slice(0, 3);
  if (top.length === 0) out.push("You are on top of things. Keep your records up to date.");
  else top.forEach((i, n) => out.push(`${n + 1}. ${clean(i.title)}${i.detail ? `: ${clean(i.detail).slice(0, 160)}` : ""}`));

  out.push("", "This brief is generated from your own data. It is information, not legal or financial advice.");
  return out.join("\n");
}

export interface BriefOpts {
  now?: Date;
  tools?: ToolDef[];
  emailEnabled?: boolean;
}

/** Create this week's brief for one business if it does not exist yet. Returns true if one was created. Safe to call repeatedly and concurrently. */
export async function generateBriefForBusiness(sql: Sql, businessId: string, opts: BriefOpts = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const weekStart = weekStartOf(now);
  if (!(await briefEnabled(businessId))) return false;
  const [exists] = await sql`SELECT 1 FROM weekly_briefs WHERE business_id = ${businessId} AND week_start = ${weekStart}`;
  if (exists) return false;
  const ctx = await buildSystemContext(sql, businessId, opts.tools);
  if (!ctx) return false;
  const bc = await ctx.context();
  const tools = opts.tools ?? (await import("@/lib/tools/registry")).TOOLS;
  const md = buildBriefMarkdown({
    businessName: ctx.business.name,
    weekStart,
    today: isoDate(now),
    attention: bc.attention,
    summaries: bc.summaries,
    toolNames: Object.fromEntries(tools.map((t) => [t.id, t.name])),
  });
  const emailOn = opts.emailEnabled ?? getEmailProvider().enabled;
  return sql.begin(async (tx) => {
    const t = tx as unknown as Sql;
    const ins = await t`INSERT INTO weekly_briefs (business_id, week_start, content_md) VALUES (${businessId}, ${weekStart}, ${md}) ON CONFLICT DO NOTHING RETURNING id`;
    if (!ins.length) return false;
    await createNotification(t, businessId, { title: "Your weekly business brief is ready", href: "/app/notifications", severity: "info", dedupeKey: `weekly-brief:${weekStart}` }, { emailEnabled: false });
    if (emailOn) {
      const mail = renderBriefEmail(`Your weekly business brief: ${ctx.business.name}`, md);
      for (const r of (await emailRecipients(t, businessId, { weeklyBrief: true })).filter((r) => !r.quietTypes.includes("weekly-brief"))) await enqueueEmail(t, businessId, r.email, mail);
    }
    return true;
  });
}

export async function latestBrief(sql: Sql, businessId: string): Promise<{ weekStart: string; contentMd: string } | null> {
  const [r] = await sql<{ week_start: string; content_md: string }[]>`
    SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start, content_md FROM weekly_briefs WHERE business_id = ${businessId} ORDER BY week_start DESC LIMIT 1`;
  return r ? { weekStart: r.week_start, contentMd: r.content_md } : null;
}
