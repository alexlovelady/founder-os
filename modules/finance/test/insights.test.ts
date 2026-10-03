import { describe, expect, it } from "vitest";
import { buildSnapshot, computeInsights, isFirstOfMonth, normalizeMonth, roughUsd, type FinanceMonth } from "../src/insights";

const NOW = new Date(Date.UTC(2026, 9, 3)); // 2026-10-03
const m = (month: string, revenue: number, expenses: number, cash: number | null = null, breakdown: FinanceMonth["expenseBreakdown"] = null): FinanceMonth => ({
  month, revenueCents: revenue * 100, expensesCents: expenses * 100, cashEndCents: cash == null ? null : cash * 100, expenseBreakdown: breakdown,
});

describe("month validation helpers", () => {
  it.each([
    ["2026-09-01", true], ["2026-09-02", false], ["2026-13-01", false], ["2026-9-01", false], ["1999-01-01", false], ["", false], [null, false], [20260901, false],
  ])("isFirstOfMonth(%s) = %s", (v, ok) => expect(isFirstOfMonth(v)).toBe(ok));
  it("normalizes YYYY-MM", () => {
    expect(normalizeMonth("2026-09")).toBe("2026-09-01");
    expect(normalizeMonth("2026-09-01")).toBe("2026-09-01");
    expect(normalizeMonth("2026-09-15")).toBeNull();
  });
});

describe("computeInsights", () => {
  it("says not enough data with no months or one month", () => {
    const none = computeInsights([], NOW);
    expect(none).toMatchObject({ count: 0, enoughData: false, window: null, latestMonth: null });
    const one = computeInsights([m("2026-09-01", 5000, 4000, 10000)], NOW);
    expect(one).toMatchObject({ enoughData: false, window: null, revenueChange: null, breakEvenGapCents: null });
    expect(one.runway).toMatchObject({ status: "not_enough_data", months: null });
    expect(one.net).toEqual([{ month: "2026-09-01", netCents: 100000 }]);
  });

  it("computes net, 3-month averages, revenue change, runway and break-even gap", () => {
    const r = computeInsights([m("2026-06-01", 1000, 9000, 90000), m("2026-07-01", 4000, 7000), m("2026-08-01", 5000, 8000), m("2026-09-01", 6000, 9000, 30000)], NOW);
    expect(r.net.map((n) => n.netCents / 100)).toEqual([-8000, -3000, -3000, -3000]);
    // The window is Jul..Sep; June is outside it.
    expect(r.window).toMatchObject({ months: 3, avgRevenueCents: 500000, avgExpensesCents: 800000, avgNetCents: -300000, avgBurnCents: 300000 });
    expect(r.revenueChange).toEqual({ pct: 20, comparedTo: "2026-08-01" });
    expect(r.runway).toMatchObject({ status: "ok", months: 10, cashCents: 3000000 });
    expect(r.breakEvenGapCents).toBe(300000);
  });

  it.each([
    ["profitable", [m("2026-08-01", 5000, 3000, 100), m("2026-09-01", 5000, 4000, 100)], "not_burning", null, 0],
    ["zero cash while burning", [m("2026-08-01", 1000, 3000), m("2026-09-01", 1000, 3000, 0)], "cash_depleted", 0, 200000],
    ["negative cash", [m("2026-08-01", 1000, 3000), m("2026-09-01", 1000, 3000, -500)], "cash_depleted", 0, 200000],
    ["latest month has no cash", [m("2026-08-01", 1000, 3000, 9000), m("2026-09-01", 1000, 3000)], "no_cash", null, 200000],
  ] as const)("runway: %s", (_n, months, status, runwayMonths, gap) => {
    const r = computeInsights(months as unknown as FinanceMonth[], NOW);
    expect(r.runway.status).toBe(status);
    expect(r.runway.months).toBe(runwayMonths);
    expect(r.breakEvenGapCents).toBe(gap);
  });

  it("uses the latest month alone for burn when only one earlier month is not adjacent", () => {
    const r = computeInsights([m("2026-03-01", 1000, 1000), m("2026-09-01", 1000, 3000, 8000)], NOW);
    expect(r.window?.months).toBe(1);
    expect(r.runway).toMatchObject({ status: "ok", months: 4 });
    expect(r.runway.basis).toMatch(/latest month/);
    expect(r.revenueChange).toEqual({ pct: null, comparedTo: null }); // not consecutive: no comparison
  });

  it("revenue change is null when the previous month had no revenue", () => {
    expect(computeInsights([m("2026-08-01", 0, 100), m("2026-09-01", 500, 100)], NOW).revenueChange).toEqual({ pct: null, comparedTo: "2026-08-01" });
  });

  it("finds the largest expense category from the latest month that has a breakdown", () => {
    const r = computeInsights([m("2026-07-01", 1, 1000, null, { rent: 90000, software: 10000 }), m("2026-08-01", 1, 1000), m("2026-09-01", 1, 1000, null, { payroll: 60000, rent: 30000, other: 10000 })], NOW);
    expect(r.largestExpense).toEqual({ month: "2026-09-01", category: "payroll", cents: 60000, sharePct: 60 });
    expect(computeInsights([m("2026-08-01", 1, 1), m("2026-09-01", 1, 1)], NOW).largestExpense).toBeNull();
  });

  it.each([
    ["2026-10-01", false, 2], ["2026-09-01", false, 32], ["2026-08-01", true, 63], ["2026-01-01", true, 275],
  ])("freshness for latest month starting %s", (latest, stale, age) => {
    const r = computeInsights([m("2025-12-01", 1, 1), m(latest, 1, 1)], NOW);
    expect(r.freshness).toEqual({ stale, ageDays: age });
  });

  it("stale means the month started more than 45 days ago", () => {
    const on = (d: number) => computeInsights([m("2026-08-01", 1, 1), m("2026-09-01", 1, 1)], new Date(Date.UTC(2026, 8, d))).freshness;
    expect(on(15)).toEqual({ stale: false, ageDays: 14 });
    const oct = (d: number) => computeInsights([m("2026-08-01", 1, 1), m("2026-09-01", 1, 1)], new Date(Date.UTC(2026, 9, d))).freshness;
    expect(oct(16)).toEqual({ stale: false, ageDays: 45 });
    expect(oct(17)).toEqual({ stale: true, ageDays: 46 });
  });
});

describe("buildSnapshot", () => {
  it("is null with no months", () => expect(buildSnapshot([], NOW)).toBeNull());
  it("has the documented shape", () => {
    expect(buildSnapshot([m("2026-08-01", 4000, 6000, 20000), m("2026-09-01", 5000, 6000, 10000)], NOW)).toEqual({
      month: "2026-09-01", revenueCents: 500000, expensesCents: 600000, cashCents: 1000000, netCents: -100000, runwayMonths: 6.7, source: "entered", stale: false,
    });
  });
  it("has null runway with one month or no cash", () => {
    expect(buildSnapshot([m("2026-09-01", 5000, 6000, 10000)], NOW)).toMatchObject({ runwayMonths: null, cashCents: 1000000, stale: false });
    expect(buildSnapshot([m("2026-01-01", 5000, 6000)], NOW)).toMatchObject({ cashCents: null, runwayMonths: null, stale: true });
  });
});

describe("roughUsd", () => {
  it.each([[123456, "$1,200"], [1234567, "$12,000"], [123456789, "$1,230,000"], [4321, "$40"], [-250000, "-$2,500"]])("%i cents -> %s", (c, s) => expect(roughUsd(c)).toBe(s));
});
