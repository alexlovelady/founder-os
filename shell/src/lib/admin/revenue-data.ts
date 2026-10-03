import type { Sql } from "@founderos/sdk";
import { getBillingConfig } from "@/lib/billing/config";
import { monthlySeries, summarizeRevenue, trialConversion, type Conversion, type MonthPoint, type RevenueSummary, type RevSub } from "./revenue";

export interface RevenueReport {
  billingEnabled: boolean;
  summary: RevenueSummary;
  series: MonthPoint[];
  conversion: Conversion;
  /** Tracked subscription_started events in the last 6 months (0 means the new-subscriptions series has no data). */
  startedEvents: number;
}

/** Load subscriptions, overrides and analytics, then run the pure math. Counts only; no business content. */
export async function loadRevenue(sql: Sql, now: Date = new Date(), env: Record<string, string | undefined> = process.env): Promise<RevenueReport> {
  const subRows = await sql<{ business_id: string; plan: string; status: string; updated_at: Date }[]>`SELECT business_id, plan, status, updated_at FROM subscriptions`;
  const subs: RevSub[] = subRows.map((r) => ({ businessId: r.business_id, plan: r.plan, status: r.status, updatedAt: r.updated_at }));
  const overrides = new Set((await sql<{ business_id: string }[]>`SELECT business_id FROM plan_overrides`).map((r) => r.business_id));
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
  const started = await sql<{ business_id: string | null; created_at: Date }[]>`
    SELECT business_id, created_at FROM analytics_events WHERE name = 'subscription_started' AND created_at >= ${since}`;
  const everStarted = await sql<{ business_id: string }[]>`SELECT DISTINCT business_id FROM analytics_events WHERE name = 'subscription_started' AND business_id IS NOT NULL`;
  const canceled = subs.filter((s) => s.status === "canceled").map((s) => s.updatedAt);
  return {
    billingEnabled: getBillingConfig(env).enabled,
    summary: summarizeRevenue(subs, overrides, now),
    series: monthlySeries(started.map((s) => s.created_at), canceled, now, 6),
    conversion: trialConversion(everStarted.map((r) => r.business_id), subs),
    startedEvents: started.length,
  };
}
