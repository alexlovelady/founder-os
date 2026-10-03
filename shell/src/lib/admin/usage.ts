import type { Sql } from "@founderos/sdk";

/**
 * Usage and AI cost aggregation over usage_events. Admin-only; returns totals per metric / business / day, never any content.
 * Honest about gaps: usage_events has no token columns (tokens exist only when a tool records a metric whose name contains "token", e.g.
 * ai_input_tokens) and cost is only present when a caller passed estimated_cost_usd. There is no tool column, so coverage is reported per metric.
 */

export const TOKEN_METRIC = /token/i;
const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

export interface UsageFilter {
  /** Inclusive start (UTC midnight). */
  from: Date;
  /** Exclusive end (UTC midnight of the day after the last day shown). */
  to: Date;
  metric?: string | null;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const parseDay = (s: unknown): Date | null => {
  if (typeof s !== "string" || !DAY_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
};

/** Parse ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive days) and ?metric=. Defaults to the last 30 days including today; range is capped at 366 days. Pure. */
export function parseUsageFilter(params: { from?: unknown; to?: unknown; metric?: unknown }, now: Date = new Date()): UsageFilter {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let last = parseDay(params.to) ?? today;
  let first = parseDay(params.from) ?? new Date(last.getTime() - 29 * DAY_MS);
  if (first > last) [first, last] = [last, first];
  if ((last.getTime() - first.getTime()) / DAY_MS + 1 > MAX_RANGE_DAYS) first = new Date(last.getTime() - (MAX_RANGE_DAYS - 1) * DAY_MS);
  const metric = typeof params.metric === "string" && params.metric.trim() ? params.metric.trim().slice(0, 100) : null;
  return { from: first, to: new Date(last.getTime() + DAY_MS), metric };
}

export interface MetricUsage {
  metric: string;
  isTokenMetric: boolean;
  events: number;
  quantity: number;
  /** Sum of estimated_cost_usd over events that reported one (0 when none did). */
  costUsd: number;
  eventsWithCost: number;
  eventsWithModel: number;
}
export interface BusinessUsage { businessId: string; businessName: string; events: number; quantity: number; costUsd: number }
export interface DayUsage { day: string; events: number; quantity: number; costUsd: number }

export interface UsageReport {
  from: string;
  /** Last day shown (inclusive). */
  to: string;
  metric: string | null;
  totalEvents: number;
  /** Sum of quantity for non-token metrics (requests, ...). */
  requests: number;
  /** Sum of quantity for token metrics; null when no token metric was recorded in range ("not reported"). */
  tokens: number | null;
  costUsd: number;
  /** False when no event in range reported a cost (then cost shows as "not reported", not 0). */
  costReported: boolean;
  byMetric: MetricUsage[];
  byBusiness: BusinessUsage[];
  byDay: DayUsage[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function usageReport(sql: Sql, f: UsageFilter): Promise<UsageReport> {
  const metric = f.metric ?? null;
  const metrics = await sql<{ metric: string; events: string; quantity: string; cost: string; with_cost: string; with_model: string }[]>`
    SELECT metric, count(*) AS events, COALESCE(sum(quantity), 0) AS quantity, COALESCE(sum(estimated_cost_usd), 0) AS cost,
           count(estimated_cost_usd) AS with_cost, count(model) AS with_model
    FROM usage_events WHERE created_at >= ${f.from} AND created_at < ${f.to} AND (${metric}::text IS NULL OR metric = ${metric})
    GROUP BY metric ORDER BY cost DESC, quantity DESC, metric`;
  const businesses = await sql<{ id: string; name: string | null; events: string; quantity: string; cost: string }[]>`
    SELECT u.business_id AS id, b.name, count(*) AS events, COALESCE(sum(u.quantity), 0) AS quantity, COALESCE(sum(u.estimated_cost_usd), 0) AS cost
    FROM usage_events u LEFT JOIN businesses b ON b.id = u.business_id
    WHERE u.created_at >= ${f.from} AND u.created_at < ${f.to} AND (${metric}::text IS NULL OR u.metric = ${metric})
    GROUP BY u.business_id, b.name ORDER BY cost DESC, quantity DESC, events DESC LIMIT 200`;
  const days = await sql<{ day: Date; events: string; quantity: string; cost: string }[]>`
    SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS events, COALESCE(sum(quantity), 0) AS quantity, COALESCE(sum(estimated_cost_usd), 0) AS cost
    FROM usage_events WHERE created_at >= ${f.from} AND created_at < ${f.to} AND (${metric}::text IS NULL OR metric = ${metric})
    GROUP BY 1 ORDER BY 1`;

  const byMetric: MetricUsage[] = metrics.map((m) => ({
    metric: m.metric, isTokenMetric: TOKEN_METRIC.test(m.metric), events: Number(m.events), quantity: Number(m.quantity), costUsd: Number(m.cost),
    eventsWithCost: Number(m.with_cost), eventsWithModel: Number(m.with_model),
  }));
  const tokenMetrics = byMetric.filter((m) => m.isTokenMetric);
  const byDay = new Map(days.map((d) => [d.day.toISOString().slice(0, 10), { day: d.day.toISOString().slice(0, 10), events: Number(d.events), quantity: Number(d.quantity), costUsd: Number(d.cost) }]));
  const series: DayUsage[] = [];
  for (let t = f.from.getTime(); t < f.to.getTime(); t += DAY_MS) {
    const k = iso(new Date(t));
    series.push(byDay.get(k) ?? { day: k, events: 0, quantity: 0, costUsd: 0 });
  }
  return {
    from: iso(f.from), to: iso(new Date(f.to.getTime() - DAY_MS)), metric,
    totalEvents: byMetric.reduce((a, m) => a + m.events, 0),
    requests: byMetric.filter((m) => !m.isTokenMetric).reduce((a, m) => a + m.quantity, 0),
    tokens: tokenMetrics.length ? tokenMetrics.reduce((a, m) => a + m.quantity, 0) : null,
    costUsd: byMetric.reduce((a, m) => a + m.costUsd, 0),
    costReported: byMetric.some((m) => m.eventsWithCost > 0),
    byMetric,
    byBusiness: businesses.map((b) => ({ businessId: b.id, businessName: b.name ?? "(deleted)", events: Number(b.events), quantity: Number(b.quantity), costUsd: Number(b.cost) })),
    byDay: series,
  };
}

/** Estimated cost over the last 30 days (UTC, including today) for the cost-vs-MRR figure. */
export async function costLast30Days(sql: Sql, now: Date = new Date()): Promise<{ costUsd: number; reported: boolean }> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 29 * DAY_MS);
  const [r] = await sql<{ cost: string; n: string }[]>`SELECT COALESCE(sum(estimated_cost_usd), 0) AS cost, count(estimated_cost_usd) AS n FROM usage_events WHERE created_at >= ${from}`;
  return { costUsd: Number(r.cost), reported: Number(r.n) > 0 };
}

/** Requests (AI metric) recorded this calendar month (UTC), across all businesses. */
export async function aiRequestsThisMonth(sql: Sql, now: Date = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const [r] = await sql<{ n: string }[]>`SELECT COALESCE(sum(quantity), 0) AS n FROM usage_events WHERE metric = 'aiRequestsPerMonth' AND created_at >= ${start} AND created_at < ${end}`;
  return Number(r.n);
}

/** Distinct metric names ever recorded (for the filter dropdown). */
export async function listUsageMetrics(sql: Sql): Promise<string[]> {
  return (await sql<{ metric: string }[]>`SELECT DISTINCT metric FROM usage_events ORDER BY metric LIMIT 200`).map((r) => r.metric);
}

/** CSV cell escaping, including a guard against spreadsheet formula injection (=, +, -, @ at the start). Pure. */
export function csvCell(v: string | number | null): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type CsvView = "metric" | "business" | "day";

/** The report table as CSV. Costs are blank (not 0) where nothing reported a cost. Pure. */
export function usageCsv(r: UsageReport, view: CsvView): string {
  const rows: (string | number | null)[][] = [];
  if (view === "metric") {
    rows.push(["metric", "events", "quantity", "estimated_cost_usd", "events_with_cost", "events_with_model"]);
    for (const m of r.byMetric) rows.push([m.metric, m.events, m.quantity, m.eventsWithCost ? m.costUsd : null, m.eventsWithCost, m.eventsWithModel]);
  } else if (view === "business") {
    rows.push(["business_id", "business_name", "events", "quantity", "estimated_cost_usd"]);
    for (const b of r.byBusiness) rows.push([b.businessId, b.businessName, b.events, b.quantity, b.costUsd]);
  } else {
    rows.push(["day", "events", "quantity", "estimated_cost_usd"]);
    for (const d of r.byDay) rows.push([d.day, d.events, d.quantity, d.costUsd]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
