/**
 * Pure trend and insight functions over the monthly figures a person typed in. No database or UI, so they run in the browser and on the server.
 * Everything here is arithmetic on entered numbers. Nothing is projected beyond the data, and with fewer than 2 months it says "not enough data".
 */

export const EXPENSE_CATEGORIES = ["payroll", "contractors", "software", "marketing", "rent", "insurance", "taxes", "supplies", "other"] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Label shown with every figure. There are no bank, Stripe or accounting connections. */
export const SOURCE_LABEL = "Entered by you; not connected to a bank or accounting system";
export const STALE_DAYS = 45;
/** The breakdown may exceed the expense total by this many cents (rounding). */
export const BREAKDOWN_TOLERANCE_CENTS = 100;
export const MAX_CENTS = 1e12;

export interface FinanceMonth {
  /** First of the month, "YYYY-MM-DD". */
  month: string;
  revenueCents: number;
  expensesCents: number;
  cashEndCents: number | null;
  expenseBreakdown: Partial<Record<ExpenseCategory, number>> | null;
  notes?: string;
}

const MONTH_RE = /^(\d{4})-(\d{2})-01$/;

/** True for a real calendar date that is the first of a month (year 2000 or later). */
export function isFirstOfMonth(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = MONTH_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12;
}

/** Accepts "2026-09" or "2026-09-01" and returns "2026-09-01", or null. */
export function normalizeMonth(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = /^\d{4}-\d{2}$/.test(s) ? `${s}-01` : s;
  return isFirstOfMonth(t) ? t : null;
}

const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const round1 = (n: number) => Math.round(n * 10) / 10;

export function monthLabel(m: string): string {
  return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1)).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

export function currentMonth(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function breakdownTotal(b: Partial<Record<string, number>> | null | undefined): number {
  return b ? Object.values(b).reduce<number>((a, v) => a + (typeof v === "number" ? v : 0), 0) : 0;
}

export function formatUsd(cents: number | null | undefined): string {
  return cents == null ? "n/a" : (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export type RunwayStatus = "not_enough_data" | "no_cash" | "not_burning" | "cash_depleted" | "ok";

export interface Insights {
  count: number;
  enoughData: boolean;
  latestMonth: string | null;
  /** Net (revenue minus expenses) per month, oldest first. */
  net: { month: string; netCents: number }[];
  /** Average over the latest month and up to the 2 calendar months before it (months with no entry are not counted). */
  window: { months: number; avgRevenueCents: number; avgExpensesCents: number; avgNetCents: number; avgBurnCents: number } | null;
  /** Latest month versus the calendar month right before it. pct is null when that month is missing or had no revenue. */
  revenueChange: { pct: number | null; comparedTo: string | null } | null;
  /** Largest category in the most recent month that has a breakdown. */
  largestExpense: { month: string; category: ExpenseCategory; cents: number; sharePct: number } | null;
  runway: { status: RunwayStatus; months: number | null; cashCents: number | null; burnCents: number | null; basis: string };
  /** Extra revenue per month needed to cover expenses at the recent average. 0 when revenue already covers expenses. */
  breakEvenGapCents: number | null;
  freshness: { stale: boolean; ageDays: number | null };
}

const sortAsc = (months: FinanceMonth[]) => [...months].sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

export function computeInsights(input: FinanceMonth[], now: Date = new Date()): Insights {
  const months = sortAsc(input);
  const count = months.length;
  const latest = months[count - 1];
  const empty: Insights = {
    count, enoughData: false, latestMonth: latest?.month ?? null, net: [], window: null, revenueChange: null, largestExpense: null,
    runway: { status: "not_enough_data", months: null, cashCents: null, burnCents: null, basis: "Enter at least 2 months to see runway." },
    breakEvenGapCents: null, freshness: { stale: false, ageDays: null },
  };
  if (!latest) return empty;

  const ageDays = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(Number(latest.month.slice(0, 4)), Number(latest.month.slice(5, 7)) - 1, 1)) / 86_400_000);
  const freshness = { stale: ageDays > STALE_DAYS, ageDays };
  const net = months.map((m) => ({ month: m.month, netCents: m.revenueCents - m.expensesCents }));
  if (count < 2) return { ...empty, net, freshness };

  const li = monthIndex(latest.month);
  const win = months.filter((m) => li - monthIndex(m.month) <= 2);
  const sum = (f: (m: FinanceMonth) => number) => win.reduce((a, m) => a + f(m), 0);
  const avgRevenueCents = Math.round(sum((m) => m.revenueCents) / win.length);
  const avgExpensesCents = Math.round(sum((m) => m.expensesCents) / win.length);
  const avgNetCents = avgRevenueCents - avgExpensesCents;
  const window = { months: win.length, avgRevenueCents, avgExpensesCents, avgNetCents, avgBurnCents: Math.max(0, -avgNetCents) };

  const prev = months[count - 2];
  const consecutive = li - monthIndex(prev.month) === 1;
  const revenueChange = consecutive
    ? { pct: prev.revenueCents > 0 ? round1(((latest.revenueCents - prev.revenueCents) / prev.revenueCents) * 100) : null, comparedTo: prev.month }
    : { pct: null, comparedTo: null };

  let largestExpense: Insights["largestExpense"] = null;
  const withBreakdown = [...months].reverse().find((m) => m.expenseBreakdown && breakdownTotal(m.expenseBreakdown) > 0);
  if (withBreakdown) {
    const b = withBreakdown.expenseBreakdown!;
    const total = breakdownTotal(b);
    const [category, cents] = (Object.entries(b) as [ExpenseCategory, number][]).sort((x, y) => y[1] - x[1])[0];
    largestExpense = { month: withBreakdown.month, category, cents, sharePct: round1((cents / total) * 100) };
  }

  // Runway: latest month's cash over the recent average burn (the latest month alone when the window has just one month).
  const basisText = window.months >= 2 ? `average burn over the last ${window.months} months entered` : "burn in the latest month";
  const burnCents = window.months >= 2 ? window.avgBurnCents : Math.max(0, latest.expensesCents - latest.revenueCents);
  const cash = latest.cashEndCents;
  let runway: Insights["runway"];
  if (cash == null) runway = { status: "no_cash", months: null, cashCents: null, burnCents, basis: "Add the cash balance for your latest month to see runway." };
  else if (burnCents <= 0) runway = { status: "not_burning", months: null, cashCents: cash, burnCents: 0, basis: `Revenue covered expenses on ${window.months >= 2 ? "average" : "the latest month"}.` };
  else if (cash <= 0) runway = { status: "cash_depleted", months: 0, cashCents: cash, burnCents, basis: `Cash entered is zero or below; ${basisText}.` };
  else runway = { status: "ok", months: round1(cash / burnCents), cashCents: cash, burnCents, basis: `Latest cash divided by ${basisText}.` };

  return { count, enoughData: true, latestMonth: latest.month, net, window, revenueChange, largestExpense, runway, breakEvenGapCents: Math.max(0, -avgNetCents), freshness };
}

export interface Snapshot {
  month: string;
  revenueCents: number;
  expensesCents: number;
  cashCents: number | null;
  netCents: number;
  runwayMonths: number | null;
  source: "entered";
  stale: boolean;
}

/** What other tools (the dashboard) read from facts().finance.snapshot. Null when no months are entered. */
export function buildSnapshot(input: FinanceMonth[], now: Date = new Date()): Snapshot | null {
  if (input.length === 0) return null;
  const ins = computeInsights(input, now);
  const latest = sortAsc(input)[input.length - 1];
  return {
    month: latest.month,
    revenueCents: latest.revenueCents,
    expensesCents: latest.expensesCents,
    cashCents: latest.cashEndCents,
    netCents: latest.revenueCents - latest.expensesCents,
    runwayMonths: ins.runway.status === "ok" || ins.runway.status === "cash_depleted" ? ins.runway.months : null,
    source: "entered",
    stale: ins.freshness.stale,
  };
}

/** Roughly rounded dollars for plain-language text ("about $12,000"), so nothing sounds more precise than hand-typed figures are. */
export function roughUsd(cents: number): string {
  const d = Math.abs(cents) / 100;
  const step = d >= 100_000 ? 10_000 : d >= 10_000 ? 1_000 : d >= 1_000 ? 100 : 10;
  const r = Math.round(d / step) * step;
  return `${cents < 0 ? "-" : ""}$${r.toLocaleString("en-US")}`;
}
