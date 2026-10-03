import type { Sql } from "@founderos/sdk";
import { loadRevenue } from "./revenue-data";
import { countActiveSuspensions } from "./suspensions";
import { aiRequestsThisMonth } from "./usage";

export interface Headlines {
  billingEnabled: boolean;
  /** Estimated MRR in USD (from plan list prices, not Stripe). */
  mrr: number;
  payingSubscribers: number;
  aiRequestsThisMonth: number;
  suspended: number;
  unhandledFeedback: number;
}

export async function loadHeadlines(sql: Sql, now: Date = new Date()): Promise<Headlines> {
  const [rev, ai, suspended, [fb]] = await Promise.all([
    loadRevenue(sql, now), aiRequestsThisMonth(sql, now), countActiveSuspensions(sql),
    sql<{ n: string }[]>`SELECT count(*) AS n FROM feedback WHERE status = 'new'`,
  ]);
  return {
    billingEnabled: rev.billingEnabled, mrr: rev.summary.mrr, payingSubscribers: rev.summary.payingSubscribers,
    aiRequestsThisMonth: ai, suspended, unhandledFeedback: Number(fb.n),
  };
}
