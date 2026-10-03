import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import type { ToolContext } from "@founderos/sdk";
import { tool } from "../src/index";

/** First of the month, n months before the current one (UTC). */
const ago = (n: number) => {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1));
  return t.toISOString().slice(0, 10);
};
const body = (over: Record<string, unknown> = {}) => ({ revenueCents: 500000, expensesCents: 400000, cashEndCents: 1200000, ...over });
const put = (ctx: ToolContext, month: string, b: unknown) => call(tool, ctx, "PUT", `months/${month}`, b);

describe("monthly figures API", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv([tool]);
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("saves a month, reads it back, and replaces it on a second save", async () => {
    const m = ago(2);
    const r = await put(env.ctx, m, body({ notes: "  first  " }));
    expect(r.status).toBe(200);
    expect(r.data.month).toMatchObject({ month: m, revenueCents: 500000, expensesCents: 400000, cashEndCents: 1200000, notes: "first", source: "manual", expenseBreakdown: null });
    await put(env.ctx, m, body({ revenueCents: 700000, cashEndCents: null }));
    const list = await call(tool, env.ctx, "GET", "months");
    expect(list.data.months).toHaveLength(1);
    expect(list.data.months[0]).toMatchObject({ revenueCents: 700000, cashEndCents: null });
    expect(list.data.source).toMatch(/not connected to a bank/);
    expect(list.data.insights.enoughData).toBe(false);
    expect((await call(tool, env.ctx, "GET", `months/${m}`)).data.month.revenueCents).toBe(700000);
    expect((await call(tool, env.ctx, "GET", `months/${ago(9)}`)).status).toBe(404);
  });

  it("validates the month and the amounts", async () => {
    const cases: [string, unknown, number][] = [
      ["2026-09-15", body(), 400],
      [ago(1).replace(/-01$/, "-02"), body(), 400],
      ["2026-13-01", body(), 400],
      ["soon", body(), 400],
      [ago(-1), body(), 400], // next month: in the future
      [ago(1), body({ revenueCents: -1 }), 400],
      [ago(1), body({ expensesCents: -100 }), 400],
      [ago(1), body({ revenueCents: 1e12 }), 400],
      [ago(1), body({ revenueCents: 10.5 }), 400],
      [ago(1), body({ revenueCents: "5" }), 400],
      [ago(1), { expensesCents: 1 }, 400],
      [ago(1), body({ expenseBreakdown: { yachts: 100 } }), 400],
      [ago(1), body({ expenseBreakdown: { rent: -5 } }), 400],
      [ago(1), body({ expensesCents: 1000, expenseBreakdown: { rent: 800, payroll: 400 } }), 400],
    ];
    for (const [month, b, status] of cases) expect((await put(env.ctx, month, b)).status, `${month} ${JSON.stringify(b)}`).toBe(status);
    expect((await call(tool, env.ctx, "DELETE", "months/2026-09-15")).status).toBe(404);
  });

  it("accepts a breakdown that matches total expenses within rounding, and a negative cash balance", async () => {
    const m = ago(1);
    expect((await put(env.ctx, m, body({ expensesCents: 1000, cashEndCents: -5000, expenseBreakdown: { rent: 600, payroll: 400 } }))).status).toBe(200);
    expect((await put(env.ctx, m, body({ expensesCents: 1000, expenseBreakdown: { rent: 600, payroll: 499 } }))).status).toBe(200); // 99 cents over: rounding
    expect((await put(env.ctx, m, body({ expensesCents: 1000, expenseBreakdown: { rent: 600, payroll: 501 } }))).status).toBe(400);
    const saved = (await call(tool, env.ctx, "GET", `months/${m}`)).data.month;
    expect(saved.expenseBreakdown).toEqual({ rent: 600, payroll: 499 });
  });

  it("returns the last 24 months, oldest first", async () => {
    const e = await makeTestEnv([tool]);
    try {
      await e.sql`INSERT INTO finance_months (business_id, month, revenue_cents, expenses_cents, created_by)
        SELECT ${e.ctx.businessId}, (date_trunc('month', now()) - make_interval(months => g))::date, 100, 50, 'u' FROM generate_series(0, 29) g`;
      const months = (await call(tool, e.ctx, "GET", "months")).data.months as { month: string }[];
      expect(months).toHaveLength(24);
      expect(months[0].month < months[23].month).toBe(true);
      expect(months[23].month).toBe(ago(0));
    } finally {
      await e.cleanup();
    }
  });

  it("isolates businesses and lets only writers change figures", async () => {
    const m = ago(2);
    expect((await call(tool, env.other, "GET", "months")).data.months).toEqual([]);
    expect((await call(tool, env.other, "GET", `months/${m}`)).status).toBe(404);
    expect((await call(tool, env.other, "DELETE", `months/${m}`)).status).toBe(404);
    // The same month in another business is a separate row.
    expect((await put(env.other, m, body({ revenueCents: 1 }))).status).toBe(200);
    expect((await call(tool, env.ctx, "GET", `months/${m}`)).data.month.revenueCents).toBe(700000);
    await call(tool, env.other, "DELETE", `months/${m}`);

    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await put(viewer.ctx, m, body())).status).toBe(403);
      expect((await call(tool, viewer.ctx, "DELETE", `months/${m}`)).status).toBe(403);
      expect((await call(tool, viewer.ctx, "GET", "months")).status).toBe(200);
    } finally {
      await viewer.cleanup();
    }
  });

  it("deletes a month once", async () => {
    const m = ago(5);
    await put(env.ctx, m, body());
    expect((await call(tool, env.ctx, "DELETE", `months/${m}`)).status).toBe(200);
    expect((await call(tool, env.ctx, "DELETE", `months/${m}`)).status).toBe(404);
  });
});

describe("monthly figures: facts, describe, attention", () => {
  let env: TestEnv;
  const withCustomers = (c: ToolContext): ToolContext => ({ ...c, business: { ...c.business, operations: { ...c.business.operations, hasCustomers: true } } });
  const clear = () => env.sql`DELETE FROM finance_months WHERE business_id = ${env.ctx.businessId}`;
  const setMonths = async (rows: [string, number, number, number | null][]) => {
    await clear();
    for (const [m, rev, exp, cash] of rows) await put(env.ctx, m, { revenueCents: rev * 100, expensesCents: exp * 100, cashEndCents: cash == null ? null : cash * 100 });
  };
  // The generic "check your runway" nudge is not what these tests are about.
  const att = async (c: ToolContext = env.ctx) => (await tool.attention!(c)).filter((i) => i.id !== "finance-no-runway");
  const ids = async () => (await att(withCustomers(env.ctx))).map((i) => i.id);

  beforeAll(async () => {
    env = await makeTestEnv([tool]);
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("has a null snapshot and keeps the old keys when nothing is entered", async () => {
    const f = await tool.facts!(env.ctx);
    expect(f).toMatchObject({ calculatorsUsed: [], taxReserveConfigured: false, latestRunwayMonths: null, snapshot: null });
    expect(await tool.describe!(env.ctx)).toBe("");
  });

  it("publishes the snapshot and runway from actuals, which win over a saved calculation", async () => {
    await call(tool, env.ctx, "POST", "calculations", { kind: "runway", name: "Old", inputs: { cash: 30000, monthlyRecurringRevenue: 2000, otherMonthlyRevenue: 1000, monthlyExpenses: 8000 } });
    expect((await tool.facts!(env.ctx)).latestRunwayMonths).toBe(6);
    await setMonths([[ago(2), 4000, 6000, 20000], [ago(1), 5000, 6000, 10000], [ago(0), 5000, 7000, 8000]]);
    const f = await tool.facts!(env.ctx);
    // burn: avg revenue 4666.67, avg expenses 6333.33 -> 1666.67 per month; cash 8000
    expect(f.snapshot).toEqual({ month: ago(0), revenueCents: 500000, expensesCents: 700000, cashCents: 800000, netCents: -200000, runwayMonths: 4.8, source: "entered", stale: false });
    expect(f).toMatchObject({ latestRunwayMonths: 4.8, calculatorsUsed: ["runway"], taxReserveConfigured: false });
    const text = await tool.describe!(env.ctx);
    expect(text).toMatch(/entered by the owner/i);
    expect(text).toMatch(/revenue about \$5,000, expenses about \$7,000, cash about \$8,000/);
    expect(text.length).toBeLessThanOrEqual(600);
    const bc = await env.ctx.context();
    expect(bc.summaries.finance).toMatch(/not connected to a bank/);
  });

  it("a profitable business counts as a checked runway with no months figure", async () => {
    await clear();
    await env.sql`DELETE FROM finance_calculations WHERE business_id = ${env.ctx.businessId}`;
    await setMonths([[ago(1), 5000, 4000, 100], [ago(0), 5000, 4000, 200]]);
    expect(await tool.facts!(env.ctx)).toMatchObject({ latestRunwayMonths: null, calculatorsUsed: ["runway"], snapshot: { runwayMonths: null, netCents: 100000 } });
    expect(await ids()).toEqual([]);
  });

  it("attention: runway under 3 months is review, under 1 month and negative cash are high", async () => {
    await setMonths([[ago(1), 4000, 6000, 20000], [ago(0), 4000, 6000, 5000]]); // 2.5 months
    expect(await att()).toMatchObject([{ id: "finance-runway-low", severity: "review" }]);
    await setMonths([[ago(1), 4000, 6000, 20000], [ago(0), 4000, 6000, 1500]]); // 0.75 months
    expect(await att()).toMatchObject([{ id: "finance-runway-critical", severity: "high" }]);
    await setMonths([[ago(1), 4000, 6000, 20000], [ago(0), 4000, 6000, -50]]);
    expect(await att()).toMatchObject([{ id: "finance-negative-cash", severity: "high" }]);
    await setMonths([[ago(1), 4000, 6000, 20000], [ago(0), 4000, 6000, 60000]]); // 30 months: fine
    expect(await ids()).toEqual([]);
    await setMonths([[ago(0), 4000, 6000, 1500]]); // one month: no runway guess
    expect(await att()).toEqual([]);
  });

  it("attention: stale figures are info, and only when the business has customers", async () => {
    await setMonths([[ago(8), 4000, 3000, 9000]]);
    expect(await tool.facts!(env.ctx)).toMatchObject({ snapshot: { stale: true } });
    expect(await ids()).toEqual(["finance-stale-figures"]);
    expect((await att(withCustomers(env.ctx)))[0].severity).toBe("info");
    expect((await att()).map((i) => i.id)).not.toContain("finance-stale-figures");
    expect(await tool.describe!(env.ctx)).toMatch(/may be out of date/);
  });
});
