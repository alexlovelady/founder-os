/**
 * Revenue math for the admin portal. Pure functions only (no database, no clock unless passed in).
 * Everything here is ESTIMATED from plan list prices in config/plans.ts and the local `subscriptions` mirror; it is not read from Stripe
 * invoices, so discounts, coupons, taxes, proration and failed charges are not reflected.
 */
import { DEFAULT_PLAN, PLANS, type PlanDef } from "@/config/plans";

/** A subscription row as the revenue math needs it. */
export interface RevSub {
  businessId: string;
  plan: string;
  status: string;
  updatedAt: Date;
}

/** Statuses that count towards estimated MRR. */
export const MRR_STATUSES = ["active", "trialing", "past_due"] as const;
const DAY_MS = 86_400_000;

export interface PlanRevenue {
  plan: string;
  name: string;
  priceMonthlyUsd: number;
  /** Subscribers counted towards MRR (active + trialing + past_due, overrides excluded). */
  subscribers: number;
  /** Of those, how many are trialing. */
  trialing: number;
  /** Of those, how many are past due. */
  pastDue: number;
  mrr: number;
}

export interface RevenueSummary {
  /** Estimated monthly recurring revenue in USD. */
  mrr: number;
  /** Subscribers counted in MRR. */
  payingSubscribers: number;
  /** MRR / payingSubscribers, or null with no subscribers. Trials are included in both, so this is an estimate. */
  arpu: number | null;
  perPlan: PlanRevenue[];
  trials: number;
  pastDue: number;
  canceledLast30: number;
  canceledLast90: number;
  /** Paid subscriptions ignored because an admin plan override wins over them. */
  excludedByOverride: number;
}

const priceOf = (plans: PlanDef[], id: string): PlanDef | null => plans.find((p) => p.id === id && p.id !== DEFAULT_PLAN && p.priceMonthlyUsd > 0) ?? null;

/** Estimated MRR and subscriber counts. Free plans, overrides, and unknown plan ids contribute nothing. */
export function summarizeRevenue(subs: RevSub[], overrideBusinessIds: ReadonlySet<string>, now: Date, plans: PlanDef[] = PLANS): RevenueSummary {
  const per = new Map<string, PlanRevenue>();
  for (const p of plans) if (p.id !== DEFAULT_PLAN) per.set(p.id, { plan: p.id, name: p.name, priceMonthlyUsd: p.priceMonthlyUsd, subscribers: 0, trialing: 0, pastDue: 0, mrr: 0 });
  let excluded = 0;
  let c30 = 0;
  let c90 = 0;
  for (const s of subs) {
    if (s.status === "canceled") {
      const age = now.getTime() - s.updatedAt.getTime();
      if (age >= 0 && age <= 30 * DAY_MS) c30++;
      if (age >= 0 && age <= 90 * DAY_MS) c90++;
      continue;
    }
    if (!(MRR_STATUSES as readonly string[]).includes(s.status)) continue;
    const def = priceOf(plans, s.plan);
    if (!def) continue;
    if (overrideBusinessIds.has(s.businessId)) {
      excluded++;
      continue;
    }
    const row = per.get(def.id)!;
    row.subscribers++;
    row.mrr += def.priceMonthlyUsd;
    if (s.status === "trialing") row.trialing++;
    if (s.status === "past_due") row.pastDue++;
  }
  const perPlan = [...per.values()];
  const mrr = perPlan.reduce((a, p) => a + p.mrr, 0);
  const paying = perPlan.reduce((a, p) => a + p.subscribers, 0);
  return {
    mrr, payingSubscribers: paying, arpu: paying > 0 ? round2(mrr / paying) : null, perPlan,
    trials: perPlan.reduce((a, p) => a + p.trialing, 0), pastDue: perPlan.reduce((a, p) => a + p.pastDue, 0),
    canceledLast30: c30, canceledLast90: c90, excludedByOverride: excluded,
  };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

export interface MonthPoint { month: string; newSubscriptions: number; canceled: number }

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** The last `months` calendar months (UTC), oldest first, ending with the month of `now`. */
export function lastMonths(now: Date, months: number): string[] {
  const out: string[] = [];
  for (let i = months - 1; i >= 0; i--) out.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))));
  return out;
}

/**
 * Monthly series. "new" counts `subscription_started` analytics events (subscriptions has no created_at); "canceled" counts rows whose status is
 * canceled by the month of their updated_at (the time of the cancellation event, until the row changes again).
 */
export function monthlySeries(startedAt: Date[], canceledAt: Date[], now: Date, months = 6): MonthPoint[] {
  const keys = lastMonths(now, months);
  const pts = new Map<string, MonthPoint>(keys.map((m) => [m, { month: m, newSubscriptions: 0, canceled: 0 }]));
  for (const d of startedAt) {
    const p = pts.get(monthKey(d));
    if (p) p.newSubscriptions++;
  }
  for (const d of canceledAt) {
    const p = pts.get(monthKey(d));
    if (p) p.canceled++;
  }
  return keys.map((k) => pts.get(k)!);
}

export interface Conversion {
  /** Distinct businesses that emitted a subscription_started event. */
  started: number;
  /** Of those, how many currently hold an active (not trialing) paid subscription. */
  nowPaying: number;
  /** nowPaying / started, or null when there are no events. */
  rate: number | null;
}

/**
 * Approximate trial-to-paid conversion from analytics: of the businesses that started a subscription, the share now in status "active".
 * Null rate means there is no data (events are only recorded for businesses that allow product analytics).
 */
export function trialConversion(startedBusinessIds: string[], subs: RevSub[]): Conversion {
  const started = new Set(startedBusinessIds);
  const active = new Set(subs.filter((s) => s.status === "active" && priceOf(PLANS, s.plan)).map((s) => s.businessId));
  let paying = 0;
  for (const id of started) if (active.has(id)) paying++;
  return { started: started.size, nowPaying: paying, rate: started.size ? round2(paying / started.size) : null };
}

/** AI cost as a share of revenue, only when both are positive numbers. Returns a percentage (e.g. 12.5) or null. */
export function costPercentOfRevenue(costUsd: number | null | undefined, revenueUsd: number | null | undefined): number | null {
  if (costUsd == null || revenueUsd == null || !Number.isFinite(costUsd) || !Number.isFinite(revenueUsd)) return null;
  if (costUsd <= 0 || revenueUsd <= 0) return null;
  return round2((costUsd / revenueUsd) * 100);
}
