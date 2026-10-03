/**
 * Pure helpers for the signed-in dashboard, welcome page and command palette. No database, no React: every function takes plain data
 * so it can be unit tested. Nothing here invents numbers; every figure comes from tool facts or attention items.
 */

export type Severity = "high" | "review" | "info";

export interface AttentionLike {
  id: string;
  title: string;
  detail?: string;
  severity: Severity;
  href?: string;
  dueDate?: string;
}

/** "Good morning, Sam". Hours are 0-23 in the viewer's (or server's) local time. */
export function greeting(hour: number, firstName?: string | null): string {
  const h = Number.isFinite(hour) ? Math.floor(hour) : 12;
  const part = h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 18 ? "Good afternoon" : "Good evening";
  const name = firstName?.trim();
  return name ? `${part}, ${name}` : part;
}

export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, review: 1, info: 2 };
export const SEVERITY_LABEL: Record<Severity, string> = { high: "Urgent", review: "Review", info: "FYI" };

export function sortBySeverity<T extends { severity: Severity }>(items: T[]): T[] {
  return items.map((x, i) => ({ x, i })).sort((a, b) => SEVERITY_ORDER[a.x.severity] - SEVERITY_ORDER[b.x.severity] || a.i - b.i).map((e) => e.x);
}

/** Top `limit` items and how many are hidden behind "Show all". */
export function collapse<T>(items: T[], limit = 5): { shown: T[]; rest: T[] } {
  return { shown: items.slice(0, limit), rest: items.slice(limit) };
}

const DAY = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Parse the YYYY-MM-DD prefix of a date string into a UTC day number; null when it is not a real date. */
export function dayNumber(date: string | undefined | null): number | null {
  const m = typeof date === "string" ? DATE_RE.exec(date) : null;
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return Math.floor(t / DAY);
}

export function todayKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export interface UpcomingItem<T extends AttentionLike = AttentionLike> {
  item: T;
  daysUntil: number;
  overdue: boolean;
}

/**
 * Items with a due date that is overdue or within `days` days of today, soonest first (overdue come first, most overdue first).
 * Items without a valid due date, or due further away, are left out.
 */
export function selectUpcoming<T extends AttentionLike>(items: T[], today: string, days = 30): UpcomingItem<T>[] {
  const t = dayNumber(today);
  if (t === null) return [];
  const out: UpcomingItem<T>[] = [];
  for (const item of items) {
    const d = dayNumber(item.dueDate);
    if (d === null) continue;
    const daysUntil = d - t;
    if (daysUntil > days) continue;
    out.push({ item, daysUntil, overdue: daysUntil < 0 });
  }
  return out.sort((a, b) => a.daysUntil - b.daysUntil || SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity] || a.item.title.localeCompare(b.item.title));
}

export function describeDue(daysUntil: number): string {
  if (daysUntil < -1) return `${-daysUntil} days overdue`;
  if (daysUntil === -1) return "1 day overdue";
  if (daysUntil === 0) return "Due today";
  if (daysUntil === 1) return "Due tomorrow";
  return `Due in ${daysUntil} days`;
}

// ---------------------------------------------------------------- facts readers

type Facts = Record<string, Record<string, unknown> | undefined>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => num(v) ?? 0;

export interface HealthRow { category: string; complete: number; attention: number; missing: number; unknown: number; total: number }
export interface HealthSummary { rows: HealthRow[]; attention: number; missing: number; unknown: number; complete: number }

/** Counts per category from `facts.health.counts`; null when health publishes nothing (render "not tracked yet"). */
export function healthSummary(facts: Facts): HealthSummary | null {
  const counts = facts.health?.counts;
  if (!counts || typeof counts !== "object") return null;
  const rows: HealthRow[] = [];
  for (const [category, raw] of Object.entries(counts as Record<string, unknown>)) {
    const c = (raw ?? {}) as Record<string, unknown>;
    const row = { category, complete: count(c.complete), attention: count(c.attention), missing: count(c.missing), unknown: count(c.unknown), total: 0 };
    row.total = row.complete + row.attention + row.missing + row.unknown;
    if (row.total > 0) rows.push(row);
  }
  if (rows.length === 0) return null;
  const sum = (k: "attention" | "missing" | "unknown" | "complete") => rows.reduce((n, r) => n + r[k], 0);
  return { rows, attention: sum("attention"), missing: sum("missing"), unknown: sum("unknown"), complete: sum("complete") };
}

export interface FinanceSnapshot { cash: number | null; monthlyRevenue: number | null; monthlyExpenses: number | null; month: string | null; source: string | null }

/**
 * Reads `facts.finance.snapshot`. Two shapes are accepted: the Finance tool's own ({revenueCents, expensesCents, cashCents, month: "YYYY-MM-01"},
 * money in cents) and a plain dollar shape ({cash, monthlyRevenue, monthlyExpenses, month: "YYYY-MM"}). Null when absent or holds no number.
 */
export function readSnapshot(raw: unknown): FinanceSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? num(Number(v)) : num(v));
  const dollars = (cents: unknown) => {
    const c = n(cents);
    return c === null ? null : c / 100;
  };
  const rawMonth = typeof r.month === "string" && r.month ? r.month : null;
  const s: FinanceSnapshot = {
    cash: r.cashCents !== undefined ? dollars(r.cashCents) : n(r.cash),
    monthlyRevenue: r.revenueCents !== undefined ? dollars(r.revenueCents) : n(r.monthlyRevenue),
    monthlyExpenses: r.expensesCents !== undefined ? dollars(r.expensesCents) : n(r.monthlyExpenses),
    month: rawMonth ? rawMonth.slice(0, 7) : null, // "2026-09-01" -> "2026-09"
    source: typeof r.source === "string" && r.source ? r.source : null,
  };
  return s.cash === null && s.monthlyRevenue === null && s.monthlyExpenses === null ? null : s;
}

export function formatMoney(value: number | null): string {
  if (value === null) return "Not entered";
  const abs = Math.abs(Math.round(value)).toLocaleString("en-US");
  return `${value < 0 ? "-" : ""}$${abs}`;
}

/** "2026-09" -> "September 2026"; anything else is returned unchanged. */
export function formatMonth(month: string | null): string | null {
  if (!month) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return month;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export function formatRunway(months: number | null): string {
  if (months === null) return "Not calculated";
  if (months < 0) return "Not calculated";
  const rounded = Math.round(months * 10) / 10;
  return `${rounded} ${rounded === 1 ? "month" : "months"}`;
}

export interface FinanceView {
  runway: string;
  taxReserve: "set up" | "not set up";
  snapshot: FinanceSnapshot | null;
  /** True when there is nothing at all to show, so the card asks for numbers. */
  empty: boolean;
}

export function financeView(facts: Facts): FinanceView {
  const f = facts.finance ?? {};
  const runwayMonths = num(f.latestRunwayMonths);
  const snapshot = readSnapshot(f.snapshot);
  const taxReserve = f.taxReserveConfigured === true;
  return { runway: formatRunway(runwayMonths), taxReserve: taxReserve ? "set up" : "not set up", snapshot, empty: runwayMonths === null && !snapshot && !taxReserve };
}

export interface DocsView { count: number; expiringSoon: number; expired: number; withText: number; empty: boolean }
export function docsView(facts: Facts): DocsView {
  const v = facts.vault ?? {};
  const c = count(v.documentCount);
  return { count: c, expiringSoon: count(v.expiringSoon), expired: count(v.expired), withText: count(v.documentsWithText), empty: c === 0 };
}

export interface TasksView { open: number; overdue: number; dueThisWeek: number; empty: boolean }
export function tasksView(facts: Facts): TasksView {
  const t = facts.tasks ?? {};
  const open = count(t.open);
  return { open, overdue: count(t.overdue), dueThisWeek: count(t.dueThisWeek), empty: open === 0 && count(t.completedLast30Days) === 0 };
}

// ---------------------------------------------------------------- getting started

export const WELCOME_COOKIE = "fos_welcome";
export const HEALTH_COOKIE = "fos_health_seen";

export interface StepDef { key: "vault" | "health" | "compliance" | "ask"; title: string; detail: string; href: string; cta: string }

export const GETTING_STARTED_STEPS: StepDef[] = [
  { key: "vault", title: "Upload your main customer agreement", detail: "Keep your key contracts in one place so FounderOS can find dates and summaries.", href: "/app/t/vault", cta: "Upload a document" },
  { key: "health", title: "Review your business health", detail: "See what is covered and what you may have forgotten.", href: "/app/t/health", cta: "Review health" },
  { key: "compliance", title: "Confirm your compliance checklist", detail: "Check the items that apply to your business and mark what is done.", href: "/app/t/compliance", cta: "Open checklist" },
  { key: "ask", title: "Ask FounderOS what to work on next", detail: "Get a grounded suggestion based on your own business data.", href: "/app/t/founderai", cta: "Ask FounderOS" },
];

export interface StepState extends StepDef { done: boolean }
export interface Progress { steps: StepState[]; doneCount: number; total: number; complete: boolean }

/**
 * Which first-run steps are finished. vault and compliance come from facts; health and ask have no fact to read, so they use flags
 * (cookies set when the person clicks the button, or `askedBefore` when a conversation already exists).
 */
export function gettingStarted(facts: Facts, flags: { healthVisited?: boolean; askedBefore?: boolean } = {}): Progress {
  const done: Record<StepDef["key"], boolean> = {
    vault: count(facts.vault?.documentCount) > 0,
    health: flags.healthVisited === true,
    compliance: count(facts.compliance?.itemCount) > 0,
    ask: flags.askedBefore === true,
  };
  const steps = GETTING_STARTED_STEPS.map((s) => ({ ...s, done: done[s.key] }));
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, total: steps.length, complete: doneCount === steps.length };
}

// ---------------------------------------------------------------- command palette (Ctrl+K)

export interface Command { id: string; title: string; hint: string; href: string; keywords: string[] }

export const COMMANDS: Command[] = [
  { id: "new-task", title: "New task", hint: "Tasks", href: "/app/t/tasks", keywords: ["add", "todo", "create"] },
  { id: "ask", title: "Ask FounderOS", hint: "Assistant", href: "/app/t/founderai", keywords: ["ai", "question", "chat", "assistant"] },
  { id: "upload", title: "Upload document", hint: "Vault", href: "/app/t/vault", keywords: ["file", "contract", "vault", "add"] },
  { id: "contact", title: "Add contact", hint: "CRM", href: "/app/t/crm", keywords: ["customer", "lead", "person", "crm", "new"] },
  { id: "review", title: "Review a contract", hint: "LegalAI", href: "/app/legal", keywords: ["legal", "agreement", "lawyer", "check"] },
  { id: "settings", title: "Open settings", hint: "Settings", href: "/app/settings", keywords: ["business", "profile", "account"] },
  { id: "billing", title: "Open billing", hint: "Billing", href: "/app/billing", keywords: ["plan", "subscription", "usage", "invoice"] },
  { id: "team", title: "Open team", hint: "Team", href: "/app/team", keywords: ["members", "invite", "roles"] },
  { id: "privacy", title: "Privacy and data", hint: "Privacy", href: "/app/privacy", keywords: ["export", "delete", "download", "data"] },
];

/** True when the box should show commands: empty text, or text starting with ">". */
export function isCommandQuery(q: string): boolean {
  const t = q.trimStart();
  return t === "" || t.startsWith(">");
}

/** Commands matching the query (leading ">" ignored). All words must match the title, hint or a keyword. Title matches rank first. */
export function filterCommands(q: string, commands: Command[] = COMMANDS): Command[] {
  const words = q.trim().replace(/^>/, "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands;
  const scored: { c: Command; score: number }[] = [];
  for (const c of commands) {
    const title = c.title.toLowerCase();
    const rest = `${c.hint} ${c.keywords.join(" ")}`.toLowerCase();
    if (!words.every((w) => title.includes(w) || rest.includes(w))) continue;
    scored.push({ c, score: words.every((w) => title.includes(w)) ? (title.startsWith(words[0]) ? 0 : 1) : 2 });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.c);
}

/** Move the highlighted row by `delta`, wrapping at both ends. */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return (((current + delta) % length) + length) % length;
}

// ---------------------------------------------------------------- ask box

export const SUGGESTED_PROMPTS = [
  "What should I work on this week?",
  "What am I missing before hiring someone?",
  "Summarize my business risks",
  "Which documents are expiring soon?",
];

export function askErrorMessage(status: number, serverError?: string): string {
  if (status === 402) return serverError || "You have reached your plan limit for AI questions this month. See Billing to upgrade or wait for the next period.";
  if (status === 401 || status === 403) return serverError || "You do not have permission to ask questions here.";
  if (status === 503) return serverError || "AI is not available for this business yet. Your question was not sent.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  return serverError || "Could not send your question. Try again in a moment.";
}
