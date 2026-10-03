import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolAction } from "@founderos/sdk";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";

const action = (): ToolAction => tool.actions!.find((a) => a.id === "record_month")!;
const ago = (n: number) => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 1)).toISOString().slice(0, 10);
};

describe("finance actions (assistant proposals)", () => {
  let env: TestEnv;
  let viewer: TestEnv;
  const rows = (e: TestEnv) => e.sql`SELECT to_char(month, 'YYYY-MM-DD') AS month, revenue_cents::float8 AS rev, expenses_cents::float8 AS exp, cash_end_cents::float8 AS cash, expense_breakdown AS bd, notes FROM finance_months WHERE business_id = ${e.ctx.businessId} ORDER BY month`;

  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    viewer = await makeTestEnv([tool], { role: "viewer" });
  });
  afterAll(async () => {
    await env.cleanup();
    await viewer.cleanup();
  });

  it("declares exactly record_month, medium risk, nothing destructive", () => {
    expect(tool.actions!.map((a) => a.id)).toEqual(["record_month"]);
    expect(action().risk).toBe("medium");
  });

  it("validates input", () => {
    const ok = { month: ago(1), revenueCents: 100, expensesCents: 50 };
    expect(action().input.safeParse(ok).success).toBe(true);
    expect(action().input.safeParse({ ...ok, month: ago(1).slice(0, 7) }).success).toBe(true); // YYYY-MM is normalized
    for (const bad of [{ ...ok, month: "2026-09-15" }, { ...ok, month: "last month" }, { ...ok, revenueCents: -1 }, { ...ok, expensesCents: 1.5 }, { ...ok, revenueCents: 1e12 }, { month: ago(1) }, { ...ok, cashCents: "x" }]) {
      expect(action().input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("preview for a new month has no side effects and says it does not overwrite", async () => {
    const input = action().input.parse({ month: ago(1), revenueCents: 500000, expensesCents: 400000, cashCents: 1000000 });
    const p = await action().preview(env.ctx, input);
    expect(p.summary).toMatch(/Add figures/);
    expect(p.details).toMatchObject({ Overwrites: expect.stringMatching(/^No/), "New revenue": "$5,000", "New expenses": "$4,000", "New cash": "$10,000" });
    expect(p.details).not.toHaveProperty("Old revenue");
    expect(await rows(env)).toHaveLength(0);
  });

  it("run saves the month through the API; running again is harmless", async () => {
    const input = action().input.parse({ month: ago(1), revenueCents: 500000, expensesCents: 400000, cashCents: 1000000 });
    const ctx = { ...env.ctx, idempotencyKey: "fp:k1" };
    const r1 = await action().run(ctx, input);
    await action().run(ctx, input);
    expect(r1.href).toBe("/app/t/finance");
    expect(await rows(env)).toEqual([{ month: ago(1), rev: 500000, exp: 400000, cash: 1000000, bd: null, notes: "" }]);
  });

  it("preview of an existing month shows old versus new and says it overwrites; nothing changes until run", async () => {
    await call(tool, env.ctx, "PUT", `months/${ago(1)}`, { revenueCents: 500000, expensesCents: 400000, cashEndCents: 1000000, notes: "keep me", expenseBreakdown: { rent: 300000, payroll: 100000 } });
    const input = action().input.parse({ month: ago(1), revenueCents: 600000, expensesCents: 450000 });
    const p = await action().preview(env.ctx, input);
    expect(p.summary).toMatch(/Replace/);
    expect(p.details).toMatchObject({
      "Old revenue": "$5,000", "New revenue": "$6,000", "Old expenses": "$4,000", "New expenses": "$4,500", "Old cash": "$10,000", "New cash": "$10,000", Overwrites: expect.stringMatching(/^Yes/),
    });
    expect((await rows(env))[0]).toMatchObject({ rev: 500000 });

    await action().run(env.ctx, input);
    expect((await rows(env))[0]).toMatchObject({ rev: 600000, exp: 450000, cash: 1000000, notes: "keep me", bd: { rent: 300000, payroll: 100000 } }); // omitted cash, notes and a still-valid breakdown are kept
  });

  it("clears a saved breakdown that no longer fits the new expenses, and the preview says so", async () => {
    const input = action().input.parse({ month: ago(1), revenueCents: 600000, expensesCents: 100000, cashCents: 5000 });
    const p = await action().preview(env.ctx, input);
    expect(p.details).toHaveProperty("Expense breakdown");
    await action().run(env.ctx, input);
    expect((await rows(env))[0]).toMatchObject({ exp: 100000, cash: 5000, bd: null });
  });

  it("only touches its own business", async () => {
    const input = action().input.parse({ month: ago(1), revenueCents: 1, expensesCents: 1 });
    expect((await action().preview(env.other, input)).summary).toMatch(/Add figures/); // the other business has no such month
    await action().run(env.other, input);
    expect((await rows(env))[0]).toMatchObject({ exp: 100000 });
    expect(await env.sql`SELECT 1 FROM finance_months WHERE business_id = ${env.other.businessId}`).toHaveLength(1);
  });

  it("viewers cannot run it", async () => {
    await expect(action().run(viewer.ctx, { month: ago(1), revenueCents: 1, expensesCents: 1 })).rejects.toMatchObject({ status: 403 });
    expect(await rows(viewer)).toHaveLength(0);
  });
});
