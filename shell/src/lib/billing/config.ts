import type { PlanId } from "@/config/plans";

export type PaidPlanId = Exclude<PlanId, "free">;
export const PAID_PLANS: PaidPlanId[] = ["founder", "pro", "business"];

export interface BillingConfig {
  /** True only when STRIPE_SECRET_KEY is set. Nothing talks to Stripe otherwise. */
  enabled: boolean;
  secretKey: string | null;
  webhookSecret: string | null;
  /** Stripe monthly price id for each paid plan, from env. A missing entry means that plan cannot be bought yet. */
  prices: Partial<Record<PaidPlanId, string>>;
  trialDays: number;
  /** Public origin of the app (for Stripe return links), if configured. */
  appUrl: string | null;
}

export function getBillingConfig(env: Record<string, string | undefined> = process.env): BillingConfig {
  const clean = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  const secretKey = clean(env.STRIPE_SECRET_KEY);
  const prices: Partial<Record<PaidPlanId, string>> = {};
  const f = clean(env.STRIPE_PRICE_FOUNDER);
  const p = clean(env.STRIPE_PRICE_PRO);
  const b = clean(env.STRIPE_PRICE_BUSINESS);
  if (f) prices.founder = f;
  if (p) prices.pro = p;
  if (b) prices.business = b;
  const trial = Number.parseInt(env.STRIPE_TRIAL_DAYS ?? "0", 10);
  return {
    enabled: secretKey !== null,
    secretKey,
    webhookSecret: clean(env.STRIPE_WEBHOOK_SECRET),
    prices,
    trialDays: Number.isFinite(trial) && trial > 0 ? Math.min(trial, 730) : 0,
    appUrl: clean(env.APP_URL ?? env.NEXT_PUBLIC_APP_URL)?.replace(/\/+$/, "") ?? null,
  };
}

/** Map a Stripe price id to our plan id. Unknown ids return null (the event is then ignored, never guessed). */
export function planForPrice(prices: BillingConfig["prices"], priceId: string | null | undefined): PaidPlanId | null {
  if (!priceId) return null;
  return PAID_PLANS.find((p) => prices[p] === priceId) ?? null;
}
