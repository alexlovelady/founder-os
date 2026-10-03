import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { breakEven, hireCompare, pricing, runway, taxReserve } from "../src/calc";
import { tool } from "../src/index";

describe("calculators", () => {
  it("runway: burn, months, and profitable businesses", () => {
    expect(runway({ cash: 30000, monthlyRecurringRevenue: 2000, otherMonthlyRevenue: 1000, monthlyExpenses: 8000 })).toMatchObject({ netBurn: 5000, runwayMonths: 6, profitable: false });
    expect(runway({ cash: 100, monthlyRecurringRevenue: 5000, otherMonthlyRevenue: 0, monthlyExpenses: 4000 })).toMatchObject({ profitable: true, runwayMonths: null });
  });
  it("break-even rounds sales up and refuses impossible cases", () => {
    expect(breakEven({ fixedExpenses: 1000, variableCostPerSale: 20, pricePerSale: 50 })).toMatchObject({ breakEvenSales: 34, contributionPerSale: 30 });
    expect(breakEven({ fixedExpenses: 1000, variableCostPerSale: 50, pricePerSale: 50 }).breakEvenSales).toBeNull();
  });
  it("pricing: target price from margin; margin must be under 100%", () => {
    expect(pricing({ labor: 50, materials: 30, overhead: 20, desiredMarginPct: 50 })).toMatchObject({ totalCost: 100, targetPrice: 200, profitAtTarget: 100 });
    expect(pricing({ labor: 1, materials: 0, overhead: 0, desiredMarginPct: 100 }).targetPrice).toBeNull();
  });
  it("contractor vs employee compares cost only and says so", () => {
    const r = hireCompare({ employeeAnnualPay: 50000, employerPayrollTaxPct: 10, annualBenefits: 5000, otherAnnualEmployeeCosts: 0, contractorHourlyRate: 40, contractorHoursPerYear: 2000 });
    expect(r).toMatchObject({ employeeTotalCost: 60000, contractorTotalCost: 80000, cheaper: "employee" });
    expect(r.note).toMatch(/classif/i);
  });
  it("tax reserve clamps the percentage", () => {
    expect(taxReserve({ periodIncome: 1000, reservePct: 25 })).toMatchObject({ reserveAmount: 250, keepAmount: 750 });
    expect(taxReserve({ periodIncome: 1000, reservePct: 400 }).reserveAmount).toBe(1000);
  });
});

describe("finance tool (database)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv([tool]);
  });
  afterAll(async () => {
    await env.cleanup();
  });

  const runwayInputs = { cash: 30000, monthlyRecurringRevenue: 2000, otherMonthlyRevenue: 1000, monthlyExpenses: 8000 };

  it("saves a calculation and recomputes the result on the server", async () => {
    const r = await call(tool, env.ctx, "POST", "calculations", { kind: "runway", name: "Base case", inputs: { ...runwayInputs }, results: { runwayMonths: 999 } });
    expect(r.status).toBe(201);
    expect(r.data.calculation.results.runwayMonths).toBe(6);
    const list = await call(tool, env.ctx, "GET", "calculations");
    expect(list.data.calculations.map((c: { name: string }) => c.name)).toEqual(["Base case"]);
  });

  it("rejects bad input", async () => {
    expect((await call(tool, env.ctx, "POST", "calculations", { kind: "runway", name: "x", inputs: { cash: -5 } })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "calculations", { kind: "nope", name: "x", inputs: {} })).status).toBe(400);
  });

  it("isolates businesses from each other", async () => {
    expect((await call(tool, env.other, "GET", "calculations")).data.calculations).toEqual([]);
    const mine = (await call(tool, env.ctx, "GET", "calculations")).data.calculations[0];
    expect((await call(tool, env.other, "DELETE", `calculations/${mine.id}`)).status).toBe(404);
    expect(await tool.resolve!(env.other, mine.id)).toBeNull();
    expect(await tool.resolve!(env.ctx, mine.id)).toMatchObject({ title: "Base case" });
  });

  it("viewers can read but not change", async () => {
    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await call(tool, viewer.ctx, "POST", "calculations", { kind: "runway", name: "n", inputs: runwayInputs })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "GET", "calculations")).status).toBe(200);
    } finally {
      await viewer.cleanup();
    }
  });

  it("publishes facts and a description, is searchable, and feeds the shared business context", async () => {
    expect(await tool.facts!(env.ctx)).toMatchObject({ calculatorsUsed: ["runway"], latestRunwayMonths: 6 });
    expect(await tool.describe!(env.ctx)).toMatch(/6 months/);
    expect((await env.ctx.search("base")).flatMap((g) => g.hits.map((h) => h.title))).toEqual(["Base case"]);
    const bc = await env.ctx.context();
    expect(bc.summaries.finance).toMatch(/runway/i);
    expect(bc.asText()).toContain("Test Co A");
  });

  it("links records across tools and resolves them; other businesses cannot touch them", async () => {
    const mine = (await call(tool, env.ctx, "GET", "calculations")).data.calculations[0];
    await env.ctx.links.add({ tool: "finance", id: mine.id }, { tool: "finance", id: mine.id }, "self");
    const linked = await env.ctx.links.list({ tool: "finance", id: mine.id });
    expect(linked[0]).toMatchObject({ tool: "finance", title: "Base case", href: "/app/t/finance" });
    await expect(env.ctx.links.add({ tool: "finance", id: mine.id }, { tool: "finance", id: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow(/do not exist/);
    await expect(env.other.links.add({ tool: "finance", id: mine.id }, { tool: "finance", id: mine.id })).rejects.toThrow();
  });
});
