/** Plan resolution, usage metering and quota enforcement. Every function takes `sql` first and is scoped by business id. */
import { HttpError, type Sql } from "@founderos/sdk";
import { DEFAULT_PLAN, PLANS, getPlan, type PlanDef } from "@/config/plans";
import { METRICS, monthWindow, resolveMetric, type MetricDef } from "./metrics";

export const PAST_DUE_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export type SubscriptionStatus = "active" | "trialing" | "past_due" | "canceled" | "unpaid" | "none";

export interface SubscriptionRow {
  business_id: string;
  plan: string;
  status: SubscriptionStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: Date | null;
  cancel_at_period_end: boolean;
  past_due_since: Date | null;
  updated_at: Date;
}
export interface OverrideRow {
  business_id: string;
  plan: string;
  limits: Record<string, number | null> | null;
  reason: string;
  set_by: string;
  created_at: Date;
}

export type PlanSource = "override" | "subscription" | "free";
export interface ResolvedPlan {
  plan: PlanDef;
  source: PlanSource;
  status: SubscriptionStatus;
  /** Set while a failed payment is inside its grace period: when the paid plan will stop applying. */
  graceEndsAt: Date | null;
  /** True when payment failed and the grace period has run out (the business is on the free plan). */
  graceExpired: boolean;
  override: OverrideRow | null;
  subscription: SubscriptionRow | null;
}

const isPaidPlan = (id: string) => PLANS.some((p) => p.id === id && p.id !== DEFAULT_PLAN);

/** Pure plan decision: override > active/trialing subscription > past_due within 7 days > free. */
export function effectivePlan(sub: SubscriptionRow | null, override: OverrideRow | null, now: Date = new Date()): ResolvedPlan {
  const status = sub?.status ?? "none";
  const base = { status, graceEndsAt: null, graceExpired: false, override, subscription: sub };
  if (override) {
    const plan = getPlan(override.plan);
    return { ...base, plan: { ...plan, limits: { ...plan.limits, ...(override.limits ?? {}) } }, source: "override" };
  }
  if (sub && isPaidPlan(sub.plan)) {
    if (status === "active" || status === "trialing") return { ...base, plan: getPlan(sub.plan), source: "subscription" };
    if (status === "past_due") {
      const since = sub.past_due_since ?? sub.updated_at;
      const graceEndsAt = new Date(since.getTime() + PAST_DUE_GRACE_DAYS * DAY_MS);
      if (now < graceEndsAt) return { ...base, plan: getPlan(sub.plan), source: "subscription", graceEndsAt };
      return { ...base, plan: getPlan(DEFAULT_PLAN), source: "free", graceExpired: true };
    }
  }
  return { ...base, plan: getPlan(DEFAULT_PLAN), source: "free" };
}

export async function resolvePlan(sql: Sql, businessId: string, now: Date = new Date()): Promise<ResolvedPlan> {
  const [subscription] = await sql<SubscriptionRow[]>`SELECT * FROM subscriptions WHERE business_id = ${businessId}`;
  const [override] = await sql<OverrideRow[]>`SELECT * FROM plan_overrides WHERE business_id = ${businessId}`;
  return effectivePlan(subscription ?? null, override ?? null, now);
}

export async function getBusinessPlan(sql: Sql, businessId: string, now: Date = new Date()): Promise<PlanDef> {
  return (await resolvePlan(sql, businessId, now)).plan;
}

async function tableExists(sql: Sql, name: string): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`SELECT to_regclass(${name}::text) IS NOT NULL AS ok`;
  return Boolean(r?.ok);
}

/** Current total for a stock metric. Tables owned by other tools may not exist (tool not installed yet), in which case the answer is 0. */
async function stockValue(sql: Sql, businessId: string, key: string): Promise<number> {
  try {
    switch (key) {
      case "teamMembers": {
        const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_members WHERE business_id = ${businessId}`;
        return r?.n ?? 0;
      }
      case "competitors": {
        if (!(await tableExists(sql, "competitors_items"))) return 0;
        const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM competitors_items WHERE business_id = ${businessId}`;
        return r?.n ?? 0;
      }
      case "productRepos": {
        if (!(await tableExists(sql, "product_repos"))) return 0;
        const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM product_repos WHERE business_id = ${businessId}`;
        return r?.n ?? 0;
      }
      case "storageMb": {
        if (!(await tableExists(sql, "vault_blobs"))) return 0;
        const [r] = await sql<{ mb: string | null }[]>`SELECT (COALESCE(SUM(octet_length(data)), 0) / 1048576.0)::text AS mb FROM vault_blobs WHERE business_id = ${businessId}`;
        return Number(r?.mb ?? 0);
      }
      default:
        return 0;
    }
  } catch {
    return 0;
  }
}

/** Usage so far: this calendar month (UTC) for monthly metrics, the current total for stock metrics. Accepts tool metric aliases. */
export async function usageThisPeriod(sql: Sql, businessId: string, metric: string, now: Date = new Date()): Promise<number> {
  const { def, name } = resolveMetric(metric);
  if (def?.kind === "stock") return stockValue(sql, businessId, def.key);
  const { start, end } = monthWindow(now);
  const [r] = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(quantity), 0)::text AS total FROM usage_events
    WHERE business_id = ${businessId} AND metric = ${name} AND created_at >= ${start} AND created_at < ${end}`;
  return Number(r?.total ?? 0);
}

export interface UsageInput {
  businessId: string;
  userId: string | null;
  metric: string;
  quantity?: number;
  model?: string | null;
  estimatedCostUsd?: number | null;
}

/** Record usage without checking any limit (e.g. token counts after the fact). Quantity is rounded up to a whole number. */
export async function recordUsage(sql: Sql, u: UsageInput): Promise<void> {
  const quantity = Math.ceil(u.quantity ?? 1);
  if (!Number.isFinite(quantity) || quantity < 0) throw new HttpError(400, "Usage quantity must be zero or more");
  await sql`
    INSERT INTO usage_events (business_id, user_id, metric, quantity, model, estimated_cost_usd)
    VALUES (${u.businessId}, ${u.userId}, ${resolveMetric(u.metric).name}, ${quantity}, ${u.model ?? null}, ${u.estimatedCostUsd ?? null})`;
}

const fmtLimit = (def: MetricDef, n: number) => (def.unit === "MB" ? (n >= 1000 ? `${n / 1000} GB` : `${n} MB`) : n.toLocaleString("en-US"));

/** The cheapest plan that raises this limit above the current one, for the upgrade message. */
function upgradeTarget(current: PlanDef, key: string): { plan: PlanDef; limit: number | null } | null {
  const cur = current.limits[key];
  if (cur === null || cur === undefined) return null;
  const higher = [...PLANS]
    .sort((a, b) => a.priceMonthlyUsd - b.priceMonthlyUsd)
    .filter((p) => p.priceMonthlyUsd > 0)
    .find((p) => p.limits[key] === null || (p.limits[key] ?? 0) > cur);
  return higher ? { plan: higher, limit: higher.limits[key] ?? null } : null;
}

export function quotaMessage(plan: PlanDef, def: MetricDef, limit: number, used: number): string {
  const lim = fmtLimit(def, limit);
  const head =
    def.kind === "monthly"
      ? limit === 0
        ? `Your ${plan.name} plan does not include ${def.noun}.`
        : `You have used ${used >= limit ? "all" : fmtLimit(def, Math.floor(used))} of the ${lim} ${def.noun} included in your ${plan.name} plan this month.`
      : limit === 0
        ? `Your ${plan.name} plan does not include ${def.noun}.`
        : `Your ${plan.name} plan allows up to ${lim} ${def.noun}, and you are at ${fmtLimit(def, Math.floor(used))}.`;
  const up = upgradeTarget(plan, def.key);
  const tail = up
    ? ` Upgrade to ${up.plan.name} to ${up.limit === null ? "remove this limit" : `raise it to ${fmtLimit(def, up.limit)}`}${def.kind === "monthly" ? ", or wait for next month." : "."}`
    : def.kind === "monthly"
      ? " It resets at the start of next month; contact us if you need more."
      : " Contact us if you need more.";
  return head + tail;
}

/**
 * Use `amount` of a metric or throw HttpError(402) with a plain-English message naming the limit and the plan that raises it.
 * Monthly metrics are recorded as usage events. Stock metrics (storage, members, ...) are only checked: the real total is counted from
 * the tables themselves. The check and the insert happen under a per-business-per-metric advisory lock, so two simultaneous requests can
 * never both take the last unit.
 */
export async function useQuota(sql: Sql, businessId: string, userId: string | null, metric: string, amount = 1): Promise<void> {
  if (!Number.isFinite(amount) || amount < 0) throw new HttpError(400, "Usage amount must be zero or more");
  const { def, name, factor } = resolveMetric(metric);
  if (!def) {
    // A metric with no plan limit (e.g. token counts): just record it.
    if (amount > 0) await recordUsage(sql, { businessId, userId, metric: name, quantity: amount });
    return;
  }
  await sql.begin(async (tx) => {
    const q = tx as unknown as Sql;
    await q`SELECT pg_advisory_xact_lock(hashtextextended(${`quota:${businessId}:${name}`}, 0))`;
    const plan = (await resolvePlan(q, businessId)).plan;
    const limit = plan.limits[def.key];
    const want = amount * factor;
    if (limit !== null && limit !== undefined) {
      const used = await usageThisPeriod(q, businessId, name);
      if (used + want > limit + 1e-9 || (limit === 0 && want > 0)) throw new HttpError(402, quotaMessage(plan, def, limit, used));
    }
    if (def.kind === "monthly" && amount > 0) await recordUsage(q, { businessId, userId, metric: name, quantity: amount });
  });
}

export interface UsageLine {
  metric: string;
  label: string;
  kind: "monthly" | "stock";
  used: number;
  /** null = unlimited */
  limit: number | null;
  /** 0-100, or null when unlimited. */
  percent: number | null;
  unit: "MB" | null;
}

export interface UsageSummary {
  plan: { id: string; name: string; priceMonthlyUsd: number };
  source: PlanSource;
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasStripeCustomer: boolean;
  /** Present while payment has failed and the paid plan is still being honoured. */
  pastDue: { graceEndsAt: string } | null;
  graceExpired: boolean;
  overrideReason: string | null;
  periodStart: string;
  periodEnd: string;
  usage: UsageLine[];
}

export async function currentUsageSummary(sql: Sql, businessId: string, now: Date = new Date()): Promise<UsageSummary> {
  const r = await resolvePlan(sql, businessId, now);
  const { start, end } = monthWindow(now);
  const usage = await Promise.all(
    METRICS.map(async (m): Promise<UsageLine> => {
      const used = await usageThisPeriod(sql, businessId, m.key, now);
      const limit = r.plan.limits[m.key] ?? null;
      const rounded = m.unit === "MB" ? Math.round(used * 10) / 10 : used;
      return {
        metric: m.key, label: m.label, kind: m.kind, used: rounded, limit,
        percent: limit === null ? null : limit === 0 ? (used > 0 ? 100 : 0) : Math.min(100, Math.round((used / limit) * 100)),
        unit: m.unit ?? null,
      };
    }),
  );
  return {
    plan: { id: r.plan.id, name: r.plan.name, priceMonthlyUsd: r.plan.priceMonthlyUsd },
    source: r.source,
    status: r.status,
    currentPeriodEnd: r.subscription?.current_period_end?.toISOString() ?? null,
    cancelAtPeriodEnd: r.subscription?.cancel_at_period_end ?? false,
    hasStripeCustomer: Boolean(r.subscription?.stripe_customer_id),
    pastDue: r.graceEndsAt ? { graceEndsAt: r.graceEndsAt.toISOString() } : null,
    graceExpired: r.graceExpired,
    overrideReason: r.override?.reason ?? null,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    usage,
  };
}

// ---- Admin hooks (the platform admin exposes these) ----

/** Grant a plan (and optionally custom limits, merged over that plan's) without Stripe. Wins over any subscription until cleared. */
export async function setPlanOverride(
  sql: Sql, businessId: string, plan: string, limits: Record<string, number | null> | null, reason: string, adminId: string,
): Promise<void> {
  if (!PLANS.some((p) => p.id === plan)) throw new HttpError(400, `Unknown plan "${plan}"`);
  if (limits) {
    for (const [k, v] of Object.entries(limits)) {
      if (!METRICS.some((m) => m.key === k)) throw new HttpError(400, `Unknown limit "${k}"`);
      if (v !== null && (!Number.isFinite(v) || v < 0)) throw new HttpError(400, `Limit "${k}" must be a number of zero or more, or null for unlimited`);
    }
  }
  await sql`
    INSERT INTO plan_overrides (business_id, plan, limits, reason, set_by)
    VALUES (${businessId}, ${plan}, ${limits ? sql.json(limits as never) : null}, ${reason}, ${adminId})
    ON CONFLICT (business_id) DO UPDATE SET plan = EXCLUDED.plan, limits = EXCLUDED.limits, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, created_at = now()`;
}

export async function clearPlanOverride(sql: Sql, businessId: string): Promise<void> {
  await sql`DELETE FROM plan_overrides WHERE business_id = ${businessId}`;
}

export interface SubscriptionListing {
  businessId: string;
  businessName: string;
  /** The plan actually in force (override, subscription or free). */
  effectivePlan: string;
  source: PlanSource;
  status: SubscriptionStatus;
  subscriptionPlan: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  override: { plan: string; limits: Record<string, number | null> | null; reason: string; setBy: string } | null;
  updatedAt: string | null;
}

export async function listSubscriptions(sql: Sql, limit = 500): Promise<SubscriptionListing[]> {
  type Row = { business_id: string; name: string } & { [K in keyof SubscriptionRow as `s_${K}`]: SubscriptionRow[K] | null } & { [K in keyof OverrideRow as `o_${K}`]: OverrideRow[K] | null };
  const rows = await sql<Row[]>`
    SELECT b.id AS business_id, b.name,
      s.plan AS s_plan, s.status AS s_status, s.stripe_customer_id AS s_stripe_customer_id, s.stripe_subscription_id AS s_stripe_subscription_id,
      s.current_period_end AS s_current_period_end, s.cancel_at_period_end AS s_cancel_at_period_end, s.past_due_since AS s_past_due_since, s.updated_at AS s_updated_at,
      o.plan AS o_plan, o.limits AS o_limits, o.reason AS o_reason, o.set_by AS o_set_by, o.created_at AS o_created_at
    FROM businesses b
    LEFT JOIN subscriptions s ON s.business_id = b.id
    LEFT JOIN plan_overrides o ON o.business_id = b.id
    ORDER BY b.created_at DESC LIMIT ${limit}`;
  const now = new Date();
  return rows.map((r) => {
    const sub: SubscriptionRow | null = r.s_status
      ? {
          business_id: r.business_id, plan: r.s_plan ?? "free", status: r.s_status, stripe_customer_id: r.s_stripe_customer_id ?? null,
          stripe_subscription_id: r.s_stripe_subscription_id ?? null, current_period_end: r.s_current_period_end ?? null,
          cancel_at_period_end: r.s_cancel_at_period_end ?? false, past_due_since: r.s_past_due_since ?? null, updated_at: r.s_updated_at ?? now,
        }
      : null;
    const ov: OverrideRow | null = r.o_plan
      ? { business_id: r.business_id, plan: r.o_plan, limits: r.o_limits ?? null, reason: r.o_reason ?? "", set_by: r.o_set_by ?? "", created_at: r.o_created_at ?? now }
      : null;
    const eff = effectivePlan(sub, ov, now);
    return {
      businessId: r.business_id, businessName: r.name, effectivePlan: eff.plan.id, source: eff.source, status: eff.status,
      subscriptionPlan: sub?.plan ?? null, stripeCustomerId: sub?.stripe_customer_id ?? null, stripeSubscriptionId: sub?.stripe_subscription_id ?? null,
      currentPeriodEnd: sub?.current_period_end?.toISOString() ?? null, cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
      override: ov ? { plan: ov.plan, limits: ov.limits, reason: ov.reason, setBy: ov.set_by } : null,
      updatedAt: sub?.updated_at.toISOString() ?? null,
    };
  });
}
