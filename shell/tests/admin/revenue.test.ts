import { describe, expect, it } from "vitest";
import { costPercentOfRevenue, lastMonths, monthlySeries, summarizeRevenue, trialConversion, type RevSub } from "@/lib/admin/revenue";

const NOW = new Date("2026-10-15T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const sub = (businessId: string, plan: string, status: string, updatedAt = NOW): RevSub => ({ businessId, plan, status, updatedAt });

// List prices from config/plans.ts: founder 24, pro 59, business 149.
describe("summarizeRevenue (table driven)", () => {
  const cases: { name: string; subs: RevSub[]; overrides?: string[]; mrr: number; paying: number; arpu: number | null; trials?: number; pastDue?: number; c30?: number; c90?: number; excluded?: number }[] = [
    { name: "no subscriptions", subs: [], mrr: 0, paying: 0, arpu: null },
    { name: "free plan contributes nothing", subs: [sub("a", "free", "active"), sub("b", "free", "none")], mrr: 0, paying: 0, arpu: null },
    { name: "active paid plans add list prices", subs: [sub("a", "founder", "active"), sub("b", "pro", "active"), sub("c", "business", "active")], mrr: 232, paying: 3, arpu: 77.33 },
    { name: "trialing and past_due count", subs: [sub("a", "founder", "trialing"), sub("b", "pro", "past_due")], mrr: 83, paying: 2, arpu: 41.5, trials: 1, pastDue: 1 },
    { name: "unpaid and none do not count", subs: [sub("a", "pro", "unpaid"), sub("b", "pro", "none")], mrr: 0, paying: 0, arpu: null },
    { name: "overrides are excluded", subs: [sub("a", "pro", "active"), sub("b", "founder", "active")], overrides: ["a"], mrr: 24, paying: 1, arpu: 24, excluded: 1 },
    { name: "unknown plan ignored", subs: [sub("a", "enterprise", "active")], mrr: 0, paying: 0, arpu: null },
    {
      name: "cancellations windowed by updated_at",
      subs: [sub("a", "pro", "canceled", ago(5)), sub("b", "pro", "canceled", ago(45)), sub("c", "pro", "canceled", ago(120)), sub("d", "pro", "active")],
      mrr: 59, paying: 1, arpu: 59, c30: 1, c90: 2,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const r = summarizeRevenue(c.subs, new Set(c.overrides ?? []), NOW);
      expect(r.mrr).toBe(c.mrr);
      expect(r.payingSubscribers).toBe(c.paying);
      expect(r.arpu).toBe(c.arpu);
      expect(r.trials).toBe(c.trials ?? 0);
      expect(r.pastDue).toBe(c.pastDue ?? 0);
      expect(r.canceledLast30).toBe(c.c30 ?? 0);
      expect(r.canceledLast90).toBe(c.c90 ?? 0);
      expect(r.excludedByOverride).toBe(c.excluded ?? 0);
    });
  }

  it("reports subscribers per plan", () => {
    const r = summarizeRevenue([sub("a", "pro", "active"), sub("b", "pro", "trialing"), sub("c", "founder", "active")], new Set(), NOW);
    expect(r.perPlan.find((p) => p.plan === "pro")).toMatchObject({ subscribers: 2, trialing: 1, mrr: 118 });
    expect(r.perPlan.find((p) => p.plan === "founder")).toMatchObject({ subscribers: 1, mrr: 24 });
    expect(r.perPlan.some((p) => p.plan === "free")).toBe(false);
  });
});

describe("monthly series", () => {
  it("lists the last N months oldest first, across a year boundary", () => {
    expect(lastMonths(new Date("2026-02-10T00:00:00Z"), 4)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("buckets new and canceled and ignores dates outside the window", () => {
    const s = monthlySeries(
      [new Date("2026-10-01T00:00:00Z"), new Date("2026-10-20T00:00:00Z"), new Date("2026-08-31T23:59:59Z"), new Date("2025-01-01T00:00:00Z")],
      [new Date("2026-09-30T23:59:59Z"), new Date("2026-10-05T00:00:00Z")],
      NOW, 3,
    );
    expect(s).toEqual([
      { month: "2026-08", newSubscriptions: 1, canceled: 0 },
      { month: "2026-09", newSubscriptions: 0, canceled: 1 },
      { month: "2026-10", newSubscriptions: 2, canceled: 1 },
    ]);
  });
});

describe("trialConversion", () => {
  it("is null with no events", () => {
    expect(trialConversion([], [sub("a", "pro", "active")])).toEqual({ started: 0, nowPaying: 0, rate: null });
  });
  it("counts started businesses now active on a paid plan", () => {
    const r = trialConversion(["a", "b", "b", "c", "d"], [sub("a", "pro", "active"), sub("b", "founder", "trialing"), sub("c", "pro", "canceled"), sub("d", "free", "active"), sub("z", "pro", "active")]);
    expect(r).toEqual({ started: 4, nowPaying: 1, rate: 0.25 });
  });
});

describe("costPercentOfRevenue", () => {
  const cases: [number | null | undefined, number | null | undefined, number | null][] = [
    [10, 100, 10], [1, 3, 33.33], [null, 100, null], [10, null, null], [0, 100, null], [10, 0, null], [undefined, undefined, null], [Number.NaN, 5, null],
  ];
  for (const [cost, rev, want] of cases) it(`${cost} / ${rev} -> ${want}`, () => expect(costPercentOfRevenue(cost, rev)).toBe(want));
});
