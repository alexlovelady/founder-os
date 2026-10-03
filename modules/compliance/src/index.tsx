import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, uuidParam, type AttentionItem, type ToolContext, type ToolDef } from "@founderos/sdk";
import { CATEGORIES, dueState, isValidDate, nextDue, nextRuleDeadline, planSync, RECURRENCES, STATUSES, toYmd, type Category, type ItemStatus, type Recurrence } from "./engine";
import { RULES, RULES_VERSION, rulesForBusiness } from "./seed";
import { summarize } from "./summary";
import type { ItemDto, ListDto } from "./types";
import ComplianceCenter from "./ui/ComplianceCenter";
import { complianceActions } from "./actions";

const dateStr = z.string().refine(isValidDate, "Use a date like 2026-12-31");
const httpUrl = z.string().trim().max(2000).refine((u) => /^https?:\/\/[^\s]+$/i.test(u), "Use a full web address starting with https://");
const category = z.enum(CATEGORIES);
const status = z.enum(STATUSES);
const recurrence = z.enum(RECURRENCES);
const notes = z.string().max(5000);

const CreateItem = z.object({
  title: z.string().trim().min(1, "Title is required").max(200),
  description: z.string().max(2000).default(""),
  category: category.default("other"),
  status: status.default("missing"),
  dueDate: dateStr.nullable().optional(),
  recurrence: recurrence.nullable().optional(),
  sourceUrl: httpUrl.or(z.literal("")).default(""),
  sourceTitle: z.string().trim().max(200).default(""),
  notes: notes.default(""),
});

const PatchItem = z
  .object({
    status: status.optional(),
    dueDate: dateStr.nullable().optional(),
    notes: notes.optional(),
    /** Custom items only. */
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    category: category.optional(),
    recurrence: recurrence.nullable().optional(),
    sourceUrl: httpUrl.or(z.literal("")).optional(),
    sourceTitle: z.string().trim().max(200).optional(),
    /** The user checked the source today. */
    verifiedNow: z.boolean().optional(),
  })
  .strict();

const COLS = (sql: ToolContext["sql"]) => sql`
  id, rule_id, rule_version, title, description, recommendation, category, status, priority, uncertain, user_edited,
  to_char(due_date, 'YYYY-MM-DD') AS due_date, recurring, recurrence, source_url, source_title,
  to_char(last_verified, 'YYYY-MM-DD') AS last_verified, completed_at, notes`;

interface Row {
  id: string; rule_id: string | null; rule_version: number | null; title: string; description: string; recommendation: string;
  category: Category; status: ItemStatus; priority: "high" | "normal"; uncertain: boolean; user_edited: boolean; due_date: string | null;
  recurring: boolean; recurrence: Recurrence | null; source_url: string; source_title: string; last_verified: string | null;
  completed_at: Date | null; notes: string;
}

const today = () => toYmd(new Date());

const toDto = (r: Row, now: string): ItemDto => ({
  id: r.id, ruleId: r.rule_id, title: r.title, description: r.description, recommendation: r.recommendation, category: r.category, status: r.status,
  priority: r.priority, uncertain: r.uncertain, dueDate: r.due_date, dueState: dueState(r.status, r.due_date, now), recurring: r.recurring,
  recurrence: r.recurrence, sourceUrl: r.source_url, sourceTitle: r.source_title, lastVerified: r.last_verified,
  completedAt: r.completed_at ? r.completed_at.toISOString() : null, notes: r.notes, custom: r.rule_id === null,
});

async function loadRows(ctx: ToolContext): Promise<Row[]> {
  return ctx.sql<Row[]>`SELECT ${COLS(ctx.sql)} FROM compliance_items WHERE business_id = ${ctx.businessId} ORDER BY due_date ASC NULLS LAST, created_at ASC LIMIT 1000`;
}

const SEV_ORDER = { overdue: 0, soon: 1, later: 2, none: 3 } as const;
const PRIO = { high: 0, normal: 1 } as const;
function sortItems(items: ItemDto[]): ItemDto[] {
  return [...items].sort((a, b) => SEV_ORDER[a.dueState] - SEV_ORDER[b.dueState] || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") || PRIO[a.priority] - PRIO[b.priority] || a.title.localeCompare(b.title));
}

/** Idempotently brings the stored checklist in line with the rules that apply to the current profile. Returns how many rows changed. */
export async function syncChecklist(ctx: ToolContext): Promise<{ inserted: number; refreshed: number; removed: number }> {
  requireWrite(ctx);
  const now = today();
  const matches = rulesForBusiness(ctx.business, RULES);
  const existing = await ctx.sql<Row[]>`SELECT ${COLS(ctx.sql)} FROM compliance_items WHERE business_id = ${ctx.businessId} AND rule_id IS NOT NULL`;
  const plan = planSync(matches, existing.map((e) => ({ id: e.id, ruleId: e.rule_id, ruleVersion: e.rule_version, status: e.status, userEdited: e.user_edited, uncertain: e.uncertain })));
  let inserted = 0;
  for (const m of plan.insert) {
    const r = m.rule;
    const due = nextRuleDeadline(r, now);
    const res = await ctx.sql`
      INSERT INTO compliance_items (business_id, rule_id, rule_version, title, description, recommendation, category, status, priority, uncertain, due_date, recurring, recurrence, source_url, source_title, last_verified)
      VALUES (${ctx.businessId}, ${r.id}, ${r.version}, ${r.title}, ${r.description}, ${m.recommendation}, ${r.category}, 'missing', ${r.priority}, ${m.certainty === "uncertain"}, ${due}, ${r.recurrence !== null}, ${r.recurrence}, ${r.source.url}, ${r.source.title}, ${r.source.lastVerified})
      ON CONFLICT (business_id, rule_id) WHERE rule_id IS NOT NULL DO NOTHING`;
    inserted += res.count;
  }
  for (const { id, match: m } of plan.refresh) {
    const r = m.rule;
    await ctx.sql`
      UPDATE compliance_items SET rule_version = ${r.version}, title = ${r.title}, description = ${r.description}, recommendation = ${m.recommendation}, category = ${r.category},
        priority = ${r.priority}, uncertain = ${m.certainty === "uncertain"}, recurring = ${r.recurrence !== null}, recurrence = ${r.recurrence}, source_url = ${r.source.url},
        source_title = ${r.source.title}, last_verified = ${r.source.lastVerified}, updated_at = now()
      WHERE id = ${id} AND business_id = ${ctx.businessId}`;
  }
  if (plan.remove.length) await ctx.sql`DELETE FROM compliance_items WHERE business_id = ${ctx.businessId} AND id = ANY(${plan.remove}::uuid[])`;
  return { inserted, refreshed: plan.refresh.length, removed: plan.remove.length };
}

async function listAll(ctx: ToolContext): Promise<ListDto> {
  const now = today();
  const items = sortItems((await loadRows(ctx)).map((r) => toDto(r, now)));
  return { items, summary: summarize(items), rulesVersion: RULES_VERSION, today: now };
}

const ITEM_URL = (id: string) => `/app/t/compliance/i/${id}`;

export const tool: ToolDef = {
  id: "compliance",
  name: "Compliance Center",
  description: "Deadlines, filings, licenses and recurring obligations, from rules matched to your business. A checklist to review with your own advisers, not legal advice.",
  group: "business",
  status: "live",
  actions: complianceActions(() => tool),
  migrations: [
    {
      name: "0001_items",
      sql: `CREATE TABLE compliance_items (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        rule_id       text,
        rule_version  int,
        title         text NOT NULL,
        description   text NOT NULL DEFAULT '',
        recommendation text NOT NULL DEFAULT '',
        category      text NOT NULL DEFAULT 'other',
        status        text NOT NULL DEFAULT 'missing' CHECK (status IN ('complete','attention','missing','not_applicable')),
        priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal')),
        uncertain     boolean NOT NULL DEFAULT false,
        user_edited   boolean NOT NULL DEFAULT false,
        due_date      date,
        recurring     boolean NOT NULL DEFAULT false,
        recurrence    text CHECK (recurrence IS NULL OR recurrence IN ('monthly','quarterly','yearly')),
        source_url    text NOT NULL DEFAULT '',
        source_title  text NOT NULL DEFAULT '',
        last_verified date,
        completed_at  timestamptz,
        notes         text NOT NULL DEFAULT '',
        created_by    text NOT NULL DEFAULT '',
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX compliance_items_rule ON compliance_items (business_id, rule_id) WHERE rule_id IS NOT NULL;
      CREATE INDEX compliance_items_due ON compliance_items (business_id, due_date);`,
    },
  ],

  api: route({
    "GET items": async (ctx, req) => {
      const url = new URL(req.url);
      const data = await listAll(ctx);
      const st = url.searchParams.get("status");
      const cat = url.searchParams.get("category");
      if (st && !(STATUSES as readonly string[]).includes(st)) throw new HttpError(400, "status: unknown status");
      if (cat && !(CATEGORIES as readonly string[]).includes(cat)) throw new HttpError(400, "category: unknown category");
      const items = data.items.filter((i) => (!st || i.status === st) && (!cat || i.category === cat));
      return json({ ...data, items });
    },
    "POST sync": async (ctx) => {
      const result = await syncChecklist(ctx);
      return json({ ...result, ...(await listAll(ctx)) });
    },
    "GET rules": async (ctx) => {
      const matches = rulesForBusiness(ctx.business, RULES);
      return json({
        version: RULES_VERSION,
        totalRules: RULES.length,
        applicable: matches.map((m) => ({ id: m.rule.id, title: m.rule.title, certainty: m.certainty, source: m.rule.source })),
      });
    },
    "POST items": async (ctx, req) => {
      requireWrite(ctx);
      const b = await readJson(req, CreateItem);
      const [row] = await ctx.sql<Row[]>`
        INSERT INTO compliance_items (business_id, title, description, category, status, due_date, recurring, recurrence, source_url, source_title, notes, user_edited, created_by, completed_at)
        VALUES (${ctx.businessId}, ${b.title}, ${b.description}, ${b.category}, ${b.status}, ${b.dueDate ?? null}, ${!!b.recurrence}, ${b.recurrence ?? null}, ${b.sourceUrl}, ${b.sourceTitle}, ${b.notes}, true, ${ctx.userId},
          ${b.status === "complete" ? new Date() : null})
        RETURNING ${COLS(ctx.sql)}`;
      return json({ item: toDto(row, today()) }, 201);
    },
    "PATCH items/:id": async (ctx, req, p) => {
      requireWrite(ctx);
      const id = uuidParam(p.id);
      const b = await readJson(req, PatchItem);
      const [cur] = await ctx.sql<Row[]>`SELECT ${COLS(ctx.sql)} FROM compliance_items WHERE id = ${id} AND business_id = ${ctx.businessId}`;
      if (!cur) throw new HttpError(404, "Not found");
      const custom = cur.rule_id === null;
      if (!custom && (b.title !== undefined || b.description !== undefined || b.category !== undefined || b.recurrence !== undefined || b.sourceUrl !== undefined || b.sourceTitle !== undefined)) {
        throw new HttpError(400, "Only your own items can change title, category, recurrence or source; use notes for anything else");
      }
      const next = {
        title: b.title ?? cur.title,
        description: b.description ?? cur.description,
        category: b.category ?? cur.category,
        status: b.status ?? cur.status,
        due_date: b.dueDate === undefined ? cur.due_date : b.dueDate,
        notes: b.notes ?? cur.notes,
        recurrence: b.recurrence === undefined ? cur.recurrence : b.recurrence,
        source_url: b.sourceUrl ?? cur.source_url,
        source_title: b.sourceTitle ?? cur.source_title,
      };
      const completedAt = next.status === "complete" ? (cur.status === "complete" ? cur.completed_at : new Date()) : null;
      const verified = b.verifiedNow ? today() : cur.last_verified;
      const [row] = await ctx.sql<Row[]>`
        UPDATE compliance_items SET title = ${next.title}, description = ${next.description}, category = ${next.category}, status = ${next.status}, due_date = ${next.due_date},
          notes = ${next.notes}, recurrence = ${next.recurrence}, recurring = ${next.recurrence !== null}, source_url = ${next.source_url}, source_title = ${next.source_title},
          completed_at = ${completedAt}, last_verified = ${verified}, user_edited = true, updated_at = now()
        WHERE id = ${id} AND business_id = ${ctx.businessId}
        RETURNING ${COLS(ctx.sql)}`;
      return json({ item: toDto(row, today()) });
    },
    "POST items/:id/renew": async (ctx, _req, p) => {
      requireWrite(ctx);
      const id = uuidParam(p.id);
      const [cur] = await ctx.sql<Row[]>`SELECT ${COLS(ctx.sql)} FROM compliance_items WHERE id = ${id} AND business_id = ${ctx.businessId}`;
      if (!cur) throw new HttpError(404, "Not found");
      if (!cur.recurrence) throw new HttpError(400, "This item does not repeat");
      const now = today();
      const due = nextDue(cur.due_date ?? now, cur.recurrence, now);
      const [row] = await ctx.sql<Row[]>`
        UPDATE compliance_items SET status = 'missing', completed_at = NULL, due_date = ${due}, user_edited = true, updated_at = now()
        WHERE id = ${id} AND business_id = ${ctx.businessId} RETURNING ${COLS(ctx.sql)}`;
      return json({ item: toDto(row, now) });
    },
    "DELETE items/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const id = uuidParam(p.id);
      const [cur] = await ctx.sql<{ rule_id: string | null }[]>`SELECT rule_id FROM compliance_items WHERE id = ${id} AND business_id = ${ctx.businessId}`;
      if (!cur) throw new HttpError(404, "Not found");
      if (cur.rule_id) throw new HttpError(400, "Rule-based items cannot be deleted; mark them not applicable instead");
      await ctx.sql`DELETE FROM compliance_items WHERE id = ${id} AND business_id = ${ctx.businessId}`;
      return json({ ok: true });
    },
  }),

  async Page({ ctx, path }) {
    if (ctx.canWrite) await syncChecklist(ctx);
    const data = await listAll(ctx);
    const focus = path[0] === "i" && path[1] && UUID_RE.test(path[1]) ? path[1] : null;
    return <ComplianceCenter initial={data} canWrite={ctx.canWrite} focusId={focus} profileState={ctx.business.state} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const now = today();
    const items = (await loadRows(ctx)).map((r) => toDto(r, now));
    const out: AttentionItem[] = [];
    for (const i of items) {
      if (i.status === "complete" || i.status === "not_applicable") continue;
      if (i.dueState === "overdue") {
        out.push({ id: `compliance-overdue-${i.id}`, title: `Overdue: ${i.title}`, detail: `Was due ${i.dueDate}. Complete it, or update the date if it has changed.`, severity: "high", href: ITEM_URL(i.id), dueDate: i.dueDate ?? undefined });
      } else if (i.dueState === "soon") {
        out.push({ id: `compliance-soon-${i.id}`, title: `Due soon: ${i.title}`, detail: `Due ${i.dueDate}.`, severity: "review", href: ITEM_URL(i.id), dueDate: i.dueDate ?? undefined });
      } else if (i.status === "attention") {
        out.push({ id: `compliance-attn-${i.id}`, title: i.title, detail: "You marked this as needing attention.", severity: "review", href: ITEM_URL(i.id) });
      } else if (i.status === "missing" && i.priority === "high") {
        out.push({ id: `compliance-missing-${i.id}`, title: `Check: ${i.title}`, detail: i.recommendation, severity: "review", href: ITEM_URL(i.id) });
      }
    }
    const rank = (a: AttentionItem) => (a.severity === "high" ? 0 : 1);
    return out.sort((a, b) => rank(a) - rank(b) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999")).slice(0, 10);
  },

  async facts(ctx) {
    const items = (await loadRows(ctx)).map((r) => toDto(r, today()));
    const s = summarize(items);
    return {
      itemCount: s.total,
      openItems: s.open,
      overdue: s.overdue,
      dueSoon: s.dueSoon,
      complete: s.complete,
      missing: s.missing,
      attention: s.attention,
      nextDueDate: s.nextDueDate,
      categoriesMissing: s.categoriesMissing,
    };
  },

  async describe(ctx) {
    const items = (await loadRows(ctx)).map((r) => toDto(r, today()));
    if (items.length === 0) return "";
    const s = summarize(items);
    const parts = [`Compliance checklist: ${s.total - s.notApplicable} items, ${s.complete} complete, ${s.attention} need attention, ${s.missing} not yet confirmed.`];
    if (s.overdue) parts.push(`${s.overdue} overdue.`);
    const next = items.filter((i) => i.dueState !== "overdue" && i.dueDate && (i.status === "missing" || i.status === "attention")).sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string))[0];
    if (next) parts.push(`Next deadline: ${next.title.slice(0, 80)} on ${next.dueDate}.`);
    if (s.categoriesMissing.length) parts.push(`Unconfirmed areas: ${s.categoriesMissing.slice(0, 5).join(", ")}.`);
    return parts.join(" ").slice(0, 600);
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [r] = await ctx.sql<{ title: string }[]>`SELECT title FROM compliance_items WHERE id = ${id} AND business_id = ${ctx.businessId}`;
    return r ? { title: r.title, href: ITEM_URL(id) } : null;
  },

  async search(ctx, query, limit) {
    const like = "%" + query.replace(/[%_\\]/g, "") + "%";
    const rows = await ctx.sql<{ id: string; title: string; category: string; status: string }[]>`
      SELECT id, title, category, status FROM compliance_items
      WHERE business_id = ${ctx.businessId} AND (title ILIKE ${like} OR description ILIKE ${like} OR notes ILIKE ${like})
      ORDER BY due_date ASC NULLS LAST, title LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.title, snippet: `${r.category} · ${r.status.replace("_", " ")}`, href: ITEM_URL(r.id) }));
  },
};
