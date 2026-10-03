import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, type AttentionItem, type Facts, type ToolContext, type ToolDef } from "@founderos/sdk";
import { CATEGORIES, countsByCategory, evaluateAll, RULE_IDS, RULES, ruleApplies, sortItems, STATUSES, type Confirmation, type HealthItem, type Status } from "./engine";
import HealthDashboard from "./ui/HealthDashboard";

const PutConfirmation = z.object({ status: z.enum(["complete", "not_applicable"]), note: z.string().trim().max(1000).default("") }).strict();

interface ConfRow { rule_id: string; status: "complete" | "not_applicable"; note: string; confirmed_at: Date }

async function confirmations(ctx: ToolContext): Promise<Confirmation[]> {
  const rows = await ctx.sql<ConfRow[]>`SELECT rule_id, status, note, confirmed_at FROM health_confirmations WHERE business_id = ${ctx.businessId}`;
  return rows.map((r) => ({ ruleId: r.rule_id, status: r.status, note: r.note, confirmedAt: r.confirmed_at.toISOString() }));
}

/** Facts from every tool. Health's own facts() is the one caller that runs while the shared facts are being assembled (see facts()). */
async function sharedFacts(ctx: ToolContext): Promise<Facts> {
  try {
    return (await ctx.facts()) ?? {};
  } catch {
    return {};
  }
}

export async function loadItems(ctx: ToolContext, facts?: Facts): Promise<HealthItem[]> {
  const [f, confs] = await Promise.all([facts ? Promise.resolve(facts) : sharedFacts(ctx), confirmations(ctx)]);
  return sortItems(evaluateAll(RULES, ctx.business, f, confs));
}

const summarize = (items: HealthItem[]) => {
  const totals = { complete: 0, attention: 0, missing: 0, not_applicable: 0, unknown: 0 } as Record<Status, number>;
  for (const i of items) totals[i.status]++;
  return { byCategory: countsByCategory(items), totals };
};

// While ctx.facts() is being assembled it calls this tool's facts(), which itself needs ctx.facts(). A re-entrant call returns {} so the
// nested assembly (which runs the other tools) can finish; the outer call then publishes real counts.
const inFacts = new WeakSet<object>();

export const tool: ToolDef = {
  id: "health",
  name: "Business Health",
  description: "What you may be forgetting, by area: legal, compliance, finance, operations, sales, security. A prompt to check, not advice.",
  group: "business",
  status: "live",
  migrations: [
    {
      name: "0001_confirmations",
      sql: `CREATE TABLE health_confirmations (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        rule_id      text NOT NULL,
        status       text NOT NULL CHECK (status IN ('complete','not_applicable')),
        note         text NOT NULL DEFAULT '',
        confirmed_by text NOT NULL,
        confirmed_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, rule_id)
      );`,
    },
  ],

  api: route({
    "GET items": async (ctx, req) => {
      const url = new URL(req.url);
      const st = url.searchParams.get("status");
      const cat = url.searchParams.get("category");
      if (st && !(STATUSES as readonly string[]).includes(st)) throw new HttpError(400, "status: unknown status");
      if (cat && !(CATEGORIES as readonly string[]).includes(cat)) throw new HttpError(400, "category: unknown category");
      const all = await loadItems(ctx);
      return json({ items: all.filter((i) => (!st || i.status === st) && (!cat || i.category === cat)), ...summarize(all) });
    },
    "PUT confirmations/:ruleId": async (ctx, req, p) => {
      requireWrite(ctx);
      const rule = RULES.find((r) => r.id === p.ruleId);
      if (!rule || !ruleApplies(rule, ctx.business)) throw new HttpError(404, "Not found");
      const b = await readJson(req, PutConfirmation);
      await ctx.sql`
        INSERT INTO health_confirmations (business_id, rule_id, status, note, confirmed_by)
        VALUES (${ctx.businessId}, ${rule.id}, ${b.status}, ${b.note}, ${ctx.userId})
        ON CONFLICT (business_id, rule_id) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`;
      const item = (await loadItems(ctx)).find((i) => i.id === rule.id);
      return json({ item });
    },
    "DELETE confirmations/:ruleId": async (ctx, _req, p) => {
      requireWrite(ctx);
      if (!RULE_IDS.has(p.ruleId)) throw new HttpError(404, "Not found");
      const r = await ctx.sql`DELETE FROM health_confirmations WHERE business_id = ${ctx.businessId} AND rule_id = ${p.ruleId}`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },
  }),

  async Page({ ctx }) {
    const items = await loadItems(ctx);
    return <HealthDashboard initial={{ items, ...summarize(items) }} canWrite={ctx.canWrite} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const items = (await loadItems(ctx)).filter((i) => (i.status === "attention" || i.status === "missing") && i.surfaceInAttention);
    return items.slice(0, 8).map((i) => ({
      id: `health-${i.id}`,
      title: i.status === "attention" ? i.title : `Missing: ${i.title}`,
      detail: `${i.category}. ${i.reason} ${i.detail}`.slice(0, 300),
      severity: i.important || i.status === "attention" || i.category === "Legal" || i.category === "Security" ? "review" : "info",
      href: i.href,
    }));
  },

  async facts(ctx) {
    if (inFacts.has(ctx)) return {};
    inFacts.add(ctx);
    try {
      const items = await loadItems(ctx);
      const { byCategory, totals } = summarize(items);
      return { counts: byCategory, totals, attentionCount: totals.attention, missingCount: totals.missing, notTrackedCount: totals.unknown };
    } finally {
      inFacts.delete(ctx);
    }
  },

  async describe(ctx) {
    const items = await loadItems(ctx);
    if (items.length === 0) return "";
    const { totals } = summarize(items);
    const parts = [`Business health checks: ${items.length - totals.not_applicable} items, ${totals.complete} complete, ${totals.attention} need attention, ${totals.missing} missing, ${totals.unknown} not tracked yet.`];
    const top = items.filter((i) => i.status === "attention" || i.status === "missing").slice(0, 4).map((i) => i.title);
    if (top.length) parts.push(`Possibly forgotten: ${top.join("; ")}.`);
    return parts.join(" ").slice(0, 600);
  },

  async resolve(ctx, id) {
    const rule = RULES.find((r) => r.id === id);
    return rule && ruleApplies(rule, ctx.business) ? { title: rule.title, href: "/app/t/health" } : null;
  },

  async search(ctx, query, limit) {
    const q = query.trim().toLowerCase();
    return RULES.filter((r) => ruleApplies(r, ctx.business) && `${r.title} ${r.detail} ${r.category}`.toLowerCase().includes(q))
      .slice(0, limit)
      .map((r) => ({ id: r.id, title: r.title, snippet: r.category, href: "/app/t/health" }));
  },
};
