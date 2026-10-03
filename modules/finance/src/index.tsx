import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, uuidParam, type AttentionItem, type ToolContext, type ToolDef } from "@founderos/sdk";
import { breakEven, hireCompare, KINDS, pricing, runway, taxReserve, type Kind } from "./calc";
import { BREAKDOWN_TOLERANCE_CENTS, breakdownTotal, buildSnapshot, computeInsights, currentMonth, EXPENSE_CATEGORIES, isFirstOfMonth, MAX_CENTS, monthLabel, roughUsd, SOURCE_LABEL, type FinanceMonth } from "./insights";
import { financeActions } from "./actions";
import FinanceApp from "./ui/FinanceApp";

const money = z.number().finite().min(0).max(1e12);
const pct = z.number().finite().min(0).max(100);

const INPUTS = {
  runway: z.object({ cash: money, monthlyRecurringRevenue: money, otherMonthlyRevenue: money, monthlyExpenses: money }),
  break_even: z.object({ fixedExpenses: money, variableCostPerSale: money, pricePerSale: money }),
  pricing: z.object({ labor: money, materials: money, overhead: money, desiredMarginPct: pct }),
  hire_compare: z.object({ employeeAnnualPay: money, employerPayrollTaxPct: pct, annualBenefits: money, otherAnnualEmployeeCosts: money, contractorHourlyRate: money, contractorHoursPerYear: money }),
  tax_reserve: z.object({ periodIncome: money, reservePct: pct }),
} as const;

const compute = (kind: Kind, inputs: never) =>
  ({ runway, break_even: breakEven, pricing, hire_compare: hireCompare, tax_reserve: taxReserve })[kind](inputs);

const SaveBody = z.object({ kind: z.enum(KINDS), name: z.string().trim().min(1).max(120), inputs: z.record(z.string(), z.unknown()) });

const cents = z.number().int().min(0).max(MAX_CENTS - 1);
const MonthBody = z.object({
  revenueCents: cents,
  expensesCents: cents,
  cashEndCents: z.number().int().min(-MAX_CENTS + 1).max(MAX_CENTS - 1).nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
  expenseBreakdown: z.object(Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, cents.optional()])) as Record<(typeof EXPENSE_CATEGORIES)[number], z.ZodOptional<typeof cents>>).strict().nullable().optional(),
});

interface MonthRow { month: string; revenue_cents: number; expenses_cents: number; cash_end_cents: number | null; expense_breakdown: FinanceMonth["expenseBreakdown"]; notes: string; source: string; updated_at: Date }
const monthOut = (r: MonthRow) => ({
  month: r.month, revenueCents: Number(r.revenue_cents), expensesCents: Number(r.expenses_cents),
  cashEndCents: r.cash_end_cents == null ? null : Number(r.cash_end_cents),
  expenseBreakdown: r.expense_breakdown ?? null, notes: r.notes ?? "", source: r.source, updatedAt: r.updated_at.toISOString(),
});
type MonthDto = ReturnType<typeof monthOut>;

async function loadMonths(ctx: ToolContext, limit = 24): Promise<MonthDto[]> {
  const rows = await ctx.sql<MonthRow[]>`
    SELECT to_char(month, 'YYYY-MM-DD') AS month, revenue_cents::float8 AS revenue_cents, expenses_cents::float8 AS expenses_cents, cash_end_cents::float8 AS cash_end_cents,
           expense_breakdown, notes, source, updated_at
    FROM finance_months WHERE business_id = ${ctx.businessId} ORDER BY month DESC LIMIT ${limit}`;
  return rows.map(monthOut).reverse();
}

interface Row { id: string; kind: Kind; name: string; inputs: unknown; results: unknown; created_at: Date }
const out = (r: Row) => ({ id: r.id, kind: r.kind, name: r.name, inputs: r.inputs, results: r.results, createdAt: r.created_at.toISOString() });

export const tool: ToolDef = {
  id: "finance",
  name: "Finance tools",
  description: "Runway, break-even, pricing, contractor vs employee cost, and tax set-aside. Estimates to help you decide, not accounting or tax advice.",
  group: "money",
  status: "live",
  migrations: [
    {
      name: "0001_calculations",
      sql: `CREATE TABLE finance_calculations (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        kind        text NOT NULL,
        name        text NOT NULL,
        inputs      jsonb NOT NULL,
        results     jsonb NOT NULL,
        created_by  text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX finance_calculations_business ON finance_calculations (business_id, created_at DESC);`,
    },
    {
      name: "0002_monthly_figures",
      sql: `CREATE TABLE finance_months (
        business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        month             date NOT NULL CHECK (month = date_trunc('month', month)::date),
        revenue_cents     bigint NOT NULL CHECK (revenue_cents >= 0 AND revenue_cents < 1000000000000),
        expenses_cents    bigint NOT NULL CHECK (expenses_cents >= 0 AND expenses_cents < 1000000000000),
        cash_end_cents    bigint,
        expense_breakdown jsonb,
        notes             text NOT NULL DEFAULT '',
        source            text NOT NULL DEFAULT 'manual',
        created_by        text NOT NULL,
        updated_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, month)
      );`,
    },
  ],

  actions: financeActions(() => tool),

  api: route({
    "GET months": async (ctx) => {
      const months = await loadMonths(ctx);
      return json({ months, insights: computeInsights(months), source: SOURCE_LABEL });
    },
    "GET months/:month": async (ctx, _req, p) => {
      if (!isFirstOfMonth(p.month)) throw new HttpError(404, "Not found");
      const [row] = await ctx.sql<MonthRow[]>`
        SELECT to_char(month, 'YYYY-MM-DD') AS month, revenue_cents::float8 AS revenue_cents, expenses_cents::float8 AS expenses_cents, cash_end_cents::float8 AS cash_end_cents,
               expense_breakdown, notes, source, updated_at
        FROM finance_months WHERE business_id = ${ctx.businessId} AND month = ${p.month}::date`;
      if (!row) throw new HttpError(404, "Not found");
      return json({ month: monthOut(row) });
    },
    "PUT months/:month": async (ctx, req, p) => {
      requireWrite(ctx);
      if (!isFirstOfMonth(p.month)) throw new HttpError(400, "month must be the first day of a month, like 2026-09-01");
      if (p.month > currentMonth()) throw new HttpError(400, "month cannot be in the future");
      const b = await readJson(req, MonthBody);
      if (b.expenseBreakdown && breakdownTotal(b.expenseBreakdown) > b.expensesCents + BREAKDOWN_TOLERANCE_CENTS) {
        throw new HttpError(400, "expenseBreakdown: the categories add up to more than total expenses");
      }
      const [row] = await ctx.sql<MonthRow[]>`
        INSERT INTO finance_months (business_id, month, revenue_cents, expenses_cents, cash_end_cents, expense_breakdown, notes, created_by)
        VALUES (${ctx.businessId}, ${p.month}::date, ${b.revenueCents}, ${b.expensesCents}, ${b.cashEndCents ?? null},
                ${b.expenseBreakdown ? ctx.sql.json(b.expenseBreakdown as never) : null}, ${b.notes ?? ""}, ${ctx.userId})
        ON CONFLICT (business_id, month) DO UPDATE SET
          revenue_cents = EXCLUDED.revenue_cents, expenses_cents = EXCLUDED.expenses_cents, cash_end_cents = EXCLUDED.cash_end_cents,
          expense_breakdown = EXCLUDED.expense_breakdown, notes = EXCLUDED.notes, updated_at = now()
        RETURNING to_char(month, 'YYYY-MM-DD') AS month, revenue_cents::float8 AS revenue_cents, expenses_cents::float8 AS expenses_cents,
                  cash_end_cents::float8 AS cash_end_cents, expense_breakdown, notes, source, updated_at`;
      return json({ month: monthOut(row) });
    },
    "DELETE months/:month": async (ctx, _req, p) => {
      requireWrite(ctx);
      if (!isFirstOfMonth(p.month)) throw new HttpError(404, "Not found");
      const r = await ctx.sql`DELETE FROM finance_months WHERE business_id = ${ctx.businessId} AND month = ${p.month}::date`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },
    "GET calculations": async (ctx) => {
      const rows = await ctx.sql<Row[]>`SELECT id, kind, name, inputs, results, created_at FROM finance_calculations WHERE business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 100`;
      return json({ calculations: rows.map(out) });
    },
    "POST calculations": async (ctx, req) => {
      requireWrite(ctx);
      const body = await readJson(req, SaveBody);
      const parsed = INPUTS[body.kind].safeParse(body.inputs);
      if (!parsed.success) throw new HttpError(400, `${parsed.error.issues[0]?.path.join(".") || "input"}: ${parsed.error.issues[0]?.message}`);
      // Results are recomputed here, never trusted from the browser.
      const results = compute(body.kind, parsed.data as never);
      const [row] = await ctx.sql<Row[]>`
        INSERT INTO finance_calculations (business_id, kind, name, inputs, results, created_by)
        VALUES (${ctx.businessId}, ${body.kind}, ${body.name}, ${ctx.sql.json(parsed.data as never)}, ${ctx.sql.json(results as never)}, ${ctx.userId})
        RETURNING id, kind, name, inputs, results, created_at`;
      return json({ calculation: out(row) }, 201);
    },
    "DELETE calculations/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const r = await ctx.sql`DELETE FROM finance_calculations WHERE id = ${uuidParam(p.id)} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },
  }),

  async Page({ ctx }) {
    const rows = await ctx.sql<Row[]>`SELECT id, kind, name, inputs, results, created_at FROM finance_calculations WHERE business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 100`;
    const months = await loadMonths(ctx);
    return <FinanceApp initial={rows.map(out)} initialMonths={months} canWrite={ctx.canWrite} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    const months = await loadMonths(ctx);
    const ins = computeInsights(months);
    const snap = buildSnapshot(months);
    const href = "/app/t/finance";
    if (snap) {
      if (snap.stale && ctx.business.operations.hasCustomers) {
        items.push({ id: "finance-stale-figures", title: "Update your monthly figures", detail: `Your latest figures are for ${monthLabel(snap.month)}. Add last month so your numbers stay current. They are entered by you, not connected to a bank.`, severity: "info", href });
      }
      // Actuals only: figures you typed in, never a guess.
      const rm = ins.runway.status === "ok" || ins.runway.status === "cash_depleted" ? ins.runway.months : null;
      if (snap.cashCents != null && snap.cashCents < 0) {
        items.push({ id: "finance-negative-cash", title: "Your cash balance is below zero", detail: `The cash you entered for ${monthLabel(snap.month)} is negative. Review your accounts and upcoming payments.`, severity: "high", href });
      } else if (rm != null && rm < 1) {
        items.push({ id: "finance-runway-critical", title: "Less than a month of cash at your recent pace", detail: "Based on the figures you entered. Review your expenses and incoming payments now.", severity: "high", href });
      } else if (rm != null && rm < 3) {
        items.push({ id: "finance-runway-low", title: "Under three months of cash at your recent pace", detail: `Based on the figures you entered, about ${rm} months. Review your plan.`, severity: "review", href });
      }
    }
    const [has] = await ctx.sql<{ kind: string }[]>`SELECT kind FROM finance_calculations WHERE business_id = ${ctx.businessId} AND kind = 'runway' LIMIT 1`;
    if (!has && ins.runway.status !== "ok" && ins.runway.status !== "not_burning" && ins.runway.status !== "cash_depleted" && ctx.business.lifecycleStage !== "idea") {
      items.push({ id: "finance-no-runway", title: "Check how long your cash will last", detail: "Run the runway calculator with your cash and monthly expenses.", severity: "info", href: "/app/t/finance" });
    }
    return items;
  },

  async describe(ctx) {
    const rows = await ctx.sql<{ kind: string; name: string; results: Record<string, unknown> }[]>`
      SELECT kind, name, results FROM finance_calculations WHERE business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 20`;
    const months = await loadMonths(ctx);
    if (rows.length === 0 && months.length === 0) return "";
    const runwayRow = rows.find((r) => r.kind === "runway");
    const bits: string[] = [];
    const snap = buildSnapshot(months);
    if (snap) {
      const ins = computeInsights(months);
      bits.push(`Figures entered by the owner (not connected to a bank), latest month ${monthLabel(snap.month)}: revenue about ${roughUsd(snap.revenueCents)}, expenses about ${roughUsd(snap.expensesCents)}${snap.cashCents != null ? `, cash about ${roughUsd(snap.cashCents)}` : ""}${snap.stale ? " (may be out of date)" : ""}.`);
      if (ins.runway.status === "ok") bits.push(`At the recent pace that is roughly ${ins.runway.months} months of cash.`);
    }
    if (runwayRow) {
      const m = runwayRow.results.runwayMonths as number | null;
      bits.push(m == null ? "Latest runway calculation shows the business is not burning cash." : `Latest runway calculation: about ${m} months of cash.`);
    }
    if (rows.length) bits.push(`Saved calculations: ${[...new Set(rows.map((r) => r.kind.replace("_", " ")))].join(", ")}.`);
    return bits.join(" ");
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [r] = await ctx.sql<{ name: string }[]>`SELECT name FROM finance_calculations WHERE id = ${id} AND business_id = ${ctx.businessId}`;
    return r ? { title: r.name, href: "/app/t/finance" } : null;
  },

  async search(ctx, query, limit) {
    const like = "%" + query.replace(/[%_]/g, "") + "%";
    const rows = await ctx.sql<{ id: string; name: string; kind: string }[]>`
      SELECT id, name, kind FROM finance_calculations WHERE business_id = ${ctx.businessId} AND name ILIKE ${like} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.name, snippet: r.kind.replace("_", " "), href: "/app/t/finance" }));
  },

  async facts(ctx) {
    const rows = await ctx.sql<{ kind: string }[]>`SELECT DISTINCT kind FROM finance_calculations WHERE business_id = ${ctx.businessId}`;
    const [latest] = await ctx.sql<{ results: { runwayMonths: number | null } }[]>`SELECT results FROM finance_calculations WHERE business_id = ${ctx.businessId} AND kind = 'runway' ORDER BY created_at DESC LIMIT 1`;
    const months = await loadMonths(ctx);
    const snapshot = buildSnapshot(months);
    const ins = computeInsights(months);
    // Runway from the entered figures wins over an older saved calculation. A month where revenue covers expenses counts as a checked runway (null months).
    const fromActuals = ins.runway.status === "ok" || ins.runway.status === "cash_depleted" ? ins.runway.months : null;
    const actualsCheckRunway = fromActuals !== null || ins.runway.status === "not_burning";
    const used = rows.map((r) => r.kind);
    if (actualsCheckRunway && !used.includes("runway")) used.push("runway");
    return {
      calculatorsUsed: used,
      taxReserveConfigured: rows.some((r) => r.kind === "tax_reserve"),
      latestRunwayMonths: actualsCheckRunway ? fromActuals : latest?.results.runwayMonths ?? null,
      snapshot,
    };
  },
};
