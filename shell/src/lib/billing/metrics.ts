/**
 * Which usage metrics exist, whether each is counted per calendar month or is a current total ("stock"), and how tools' metric names map
 * to the limit keys in config/plans.ts. This is the one table to edit when a metric is added; limit VALUES live only in plans.ts.
 */
export type MetricKind = "monthly" | "stock";

export interface MetricDef {
  /** Key used in `plans.ts` limits (and stored in usage_events.metric for monthly metrics). */
  key: string;
  kind: MetricKind;
  /** Short label for the billing page. */
  label: string;
  /** Plural noun used in plain-English limit messages, e.g. "AI requests". */
  noun: string;
  /** Units a caller's amount is multiplied by to reach the limit's unit (e.g. bytes -> MB). */
  unitDivisor?: number;
  /** How to show a number of this metric. */
  unit?: "MB";
}

export const METRICS: MetricDef[] = [
  { key: "aiRequestsPerMonth", kind: "monthly", label: "AI requests this month", noun: "AI requests" },
  { key: "storageMb", kind: "stock", label: "Document storage", noun: "of document storage", unit: "MB" },
  { key: "teamMembers", kind: "stock", label: "Team members", noun: "team members" },
  { key: "competitors", kind: "stock", label: "Competitors tracked", noun: "tracked competitors" },
  { key: "productRepos", kind: "stock", label: "Product repositories", noun: "product repositories" },
];

/** Names tools may use (see ToolContext.useQuota) mapped to a metric key, with the divisor to convert the caller's amount. */
const ALIASES: Record<string, { key: string; divisor?: number }> = {
  ai_request: { key: "aiRequestsPerMonth" },
  ai_requests: { key: "aiRequestsPerMonth" },
  aiRequests: { key: "aiRequestsPerMonth" },
  storage_bytes: { key: "storageMb", divisor: 1024 * 1024 },
  storage_mb: { key: "storageMb" },
  team_members: { key: "teamMembers" },
  product_repos: { key: "productRepos" },
};

export interface ResolvedMetric {
  def: MetricDef | null;
  /** The name stored in usage_events.metric. */
  name: string;
  /** Multiply the caller's amount by this to get the limit's unit. */
  factor: number;
}

export function resolveMetric(metric: string): ResolvedMetric {
  const alias = ALIASES[metric];
  const key = alias?.key ?? metric;
  const def = METRICS.find((m) => m.key === key) ?? null;
  return { def, name: def?.key ?? metric, factor: alias?.divisor ? 1 / alias.divisor : 1 };
}

/** Start (inclusive) and end (exclusive) of the calendar month, in UTC, containing `now`. */
export function monthWindow(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}
