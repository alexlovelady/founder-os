import type { PlanInfo, Sql } from "@founderos/sdk";
import { getPlan } from "@/config/plans";
import { getBusinessPlan, recordUsage, useQuota as billingUseQuota } from "@/lib/billing";

/**
 * Billing is only "on" when Stripe is configured. Until then nobody can upgrade, so enforcing the Free plan limits would only lock the
 * owner out of their own product: every business gets the top plan's limits and usage is still recorded. Once STRIPE_SECRET_KEY is set,
 * subscriptions and plan overrides decide the plan and the limits are enforced.
 */
export const billingActive = () => Boolean(process.env.STRIPE_SECRET_KEY);

export async function planFor(sql: Sql, businessId: string): Promise<PlanInfo> {
  return billingActive() ? getBusinessPlan(sql, businessId) : getPlan("business");
}

export function quotaFor(sql: Sql, businessId: string, userId: string) {
  return async (metric: string, amount = 1): Promise<void> => {
    if (billingActive()) return billingUseQuota(sql, businessId, userId, metric, amount);
    if (/^ai_request/.test(metric)) await recordUsage(sql, { businessId, userId, metric: "ai_request", quantity: amount });
  };
}
