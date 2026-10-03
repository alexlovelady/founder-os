import { HttpError, type ToolContext } from "@founderos/sdk";

export interface FakePlan {
  limits?: Record<string, number | null>;
  features?: Record<string, boolean>;
  /** Current totals for stock metrics (storageMb, competitors, productRepos), read when a stock metric is checked. */
  stock?: (key: string) => Promise<number>;
}

/**
 * A copy of `ctx` on a small fake plan whose useQuota enforces limits like the shell does: monthly AI requests are counted and recorded,
 * stock metrics (storage_bytes, product_repos, competitors) are checked against the real totals and not recorded.
 */
export function withPlan(ctx: ToolContext, p: FakePlan) {
  const limits = p.limits ?? {};
  const calls: [string, number][] = [];
  const used = { ai: 0 };
  const stockKeys: Record<string, { key: string; noun: string; divisor: number }> = {
    storage_bytes: { key: "storageMb", noun: "MB of document storage", divisor: 1024 * 1024 },
    product_repos: { key: "productRepos", noun: "product repositories", divisor: 1 },
    competitors: { key: "competitors", noun: "tracked competitors", divisor: 1 },
  };
  const useQuota = async (metric: string, amount = 1): Promise<void> => {
    calls.push([metric, amount]);
    if (/^ai_request/.test(metric)) {
      const lim = limits.aiRequestsPerMonth;
      if (lim != null && used.ai + amount > lim) throw new HttpError(402, `Your Test plan includes ${lim} AI requests a month and you have used them. Upgrade your plan.`);
      used.ai += amount;
      return;
    }
    const s = stockKeys[metric];
    if (!s) return;
    const lim = limits[s.key];
    if (lim == null) return;
    const total = (await p.stock?.(s.key)) ?? 0;
    if (total + amount / s.divisor > lim + 1e-9) throw new HttpError(402, `Your Test plan includes ${lim} ${s.noun}. Upgrade your plan.`);
  };
  const out = { ...ctx, plan: { id: "test", limits, features: p.features ?? {} }, useQuota } as ToolContext;
  return { ctx: out, calls, used };
}
