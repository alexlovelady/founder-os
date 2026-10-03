import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, uuidParam, type AttentionItem, type ToolDef } from "@founderos/sdk";
import { breakEven, hireCompare, KINDS, pricing, runway, taxReserve, type Kind } from "./calc";
import Calculators from "./ui/Calculators";

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
  ],

  api: route({
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
    return <Calculators initial={rows.map(out)} canWrite={ctx.canWrite} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    const [has] = await ctx.sql<{ kind: string }[]>`SELECT kind FROM finance_calculations WHERE business_id = ${ctx.businessId} AND kind = 'runway' LIMIT 1`;
    if (!has && ctx.business.lifecycleStage !== "idea") {
      items.push({ id: "finance-no-runway", title: "Check how long your cash will last", detail: "Run the runway calculator with your cash and monthly expenses.", severity: "info", href: "/app/t/finance" });
    }
    return items;
  },

  async describe(ctx) {
    const rows = await ctx.sql<{ kind: string; name: string; results: Record<string, unknown> }[]>`
      SELECT kind, name, results FROM finance_calculations WHERE business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 20`;
    if (rows.length === 0) return "";
    const runwayRow = rows.find((r) => r.kind === "runway");
    const bits: string[] = [];
    if (runwayRow) {
      const m = runwayRow.results.runwayMonths as number | null;
      bits.push(m == null ? "Latest runway calculation shows the business is not burning cash." : `Latest runway calculation: about ${m} months of cash.`);
    }
    bits.push(`Saved calculations: ${[...new Set(rows.map((r) => r.kind.replace("_", " ")))].join(", ")}.`);
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
    return { calculatorsUsed: rows.map((r) => r.kind), taxReserveConfigured: rows.some((r) => r.kind === "tax_reserve"), latestRunwayMonths: latest?.results.runwayMonths ?? null };
  },
};
