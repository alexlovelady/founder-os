import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, uuidParam, type AttentionItem, type ToolContext, type ToolDef } from "@founderos/sdk";
import { AI_ACTIONS, AI_SYSTEM, buildPrompt, cleanAiText } from "./ai";
import { detectKeywords, nextReviewDate, today, type Frequency } from "./facts";
import { EMPTY_SOP, formatSop } from "./sop";
import { DOC_KINDS, generateDocument, KIND_LABEL, TEMPLATE_KINDS, type DocKind } from "./templates";
import SopsHome from "./ui/SopsHome";
import DocEditor from "./ui/DocEditor";
import { sopsActions } from "./actions";

const STATUSES = ["draft", "active", "archived"] as const;
const FREQS = ["none", "quarterly", "yearly"] as const;
const Text = (max: number) => z.string().max(max);

const DocBody = z.object({
  title: z.string().trim().min(1).max(200),
  kind: z.enum(DOC_KINDS).default("other"),
  body: Text(200_000).default(""),
  status: z.enum(STATUSES).default("draft"),
  review_frequency: z.enum(FREQS).default("none"),
  owner: z.string().trim().min(1).max(200).optional(),
});
const DocPatch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(DOC_KINDS).optional(),
  body: Text(200_000).optional(),
  status: z.enum(STATUSES).optional(),
  review_frequency: z.enum(FREQS).optional(),
  owner: z.string().trim().min(1).max(200).optional(),
  note: Text(200).optional(),
});
const SopForm = z.object(Object.fromEntries(Object.keys(EMPTY_SOP).map((k) => [k, Text(5000).default("")])) as Record<keyof typeof EMPTY_SOP, z.ZodDefault<z.ZodString>>);
const GenBody = z.object({ kind: z.enum(TEMPLATE_KINDS), fields: z.record(z.string(), Text(5000)).default({}) });
const AiBody = z.object({
  action: z.enum(AI_ACTIONS),
  process: Text(300).optional(),
  notes: Text(4000).optional(),
  body: Text(100_000).optional(),
  kind: z.enum(DOC_KINDS).optional(),
});

interface Row {
  id: string; title: string; kind: DocKind; body: string; status: (typeof STATUSES)[number]; owner: string;
  review_frequency: Frequency; last_reviewed: string | null; version: number; created_at: Date; updated_at: Date;
}
const COLS = `id, title, kind, body, status, owner, review_frequency, last_reviewed::text AS last_reviewed, version, created_at, updated_at`;
const out = (r: Row, withBody = true) => ({
  id: r.id, title: r.title, kind: r.kind, ...(withBody ? { body: r.body } : {}), status: r.status, owner: r.owner,
  reviewFrequency: r.review_frequency, lastReviewed: r.last_reviewed, version: r.version,
  nextReview: nextReviewDate(r.review_frequency, r.last_reviewed, r.created_at.toISOString()),
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

async function getDoc(ctx: ToolContext, id: string): Promise<Row> {
  const [r] = await ctx.sql.unsafe<Row[]>(`SELECT ${COLS} FROM sops_documents WHERE id = $1 AND business_id = $2`, [uuidParam(id), ctx.businessId]);
  if (!r) throw new HttpError(404, "Not found");
  return r;
}

async function isMember(ctx: ToolContext, userId: string) {
  const [m] = await ctx.sql`SELECT 1 FROM business_members WHERE business_id = ${ctx.businessId} AND user_id = ${userId}`;
  return !!m;
}

const profileOf = (ctx: ToolContext) => ({ name: ctx.business.name, industry: ctx.business.industry, city: ctx.business.city, state: ctx.business.state, website: ctx.business.website, entityType: ctx.business.entityType });

export const tool: ToolDef = {
  id: "sops",
  name: "SOPs & business documents",
  description: "Write your processes and everyday business documents: SOPs, proposals, quotes, policies, checklists. Templates fill from your business profile; AI drafting is optional.",
  group: "operations",
  status: "live",
  actions: sopsActions(() => tool),
  migrations: [
    {
      name: "0001_documents",
      sql: `CREATE TABLE sops_documents (
        id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        title            text NOT NULL,
        kind             text NOT NULL DEFAULT 'other',
        body             text NOT NULL DEFAULT '',
        status           text NOT NULL DEFAULT 'draft',
        owner            text NOT NULL,
        review_frequency text NOT NULL DEFAULT 'none',
        last_reviewed    date,
        version          integer NOT NULL DEFAULT 1,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX sops_documents_business ON sops_documents (business_id, updated_at DESC);
      CREATE TABLE sops_versions (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        document_id uuid NOT NULL REFERENCES sops_documents(id) ON DELETE CASCADE,
        version     integer NOT NULL,
        title       text NOT NULL,
        body        text NOT NULL,
        note        text NOT NULL DEFAULT '',
        changed_by  text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (document_id, version)
      );
      CREATE INDEX sops_versions_doc ON sops_versions (business_id, document_id, version DESC);`,
    },
  ],

  api: route({
    "GET documents": async (ctx, req) => {
      const kind = new URL(req.url).searchParams.get("kind");
      const rows = await ctx.sql.unsafe<Row[]>(
        `SELECT ${COLS} FROM sops_documents WHERE business_id = $1 ${kind && (DOC_KINDS as readonly string[]).includes(kind) ? "AND kind = $2" : ""} ORDER BY updated_at DESC LIMIT 500`,
        kind && (DOC_KINDS as readonly string[]).includes(kind) ? [ctx.businessId, kind] : [ctx.businessId],
      );
      return json({ documents: rows.map((r) => out(r, false)) });
    },
    "POST documents": async (ctx, req) => {
      requireWrite(ctx);
      const b = await readJson(req, DocBody);
      if (b.owner && !(await isMember(ctx, b.owner))) throw new HttpError(400, "owner: must be a member of this business");
      const owner = b.owner ?? ctx.userId;
      const row = await ctx.sql.begin(async (tx) => {
        const [r] = await tx.unsafe<Row[]>(
          `INSERT INTO sops_documents (business_id, title, kind, body, status, owner, review_frequency) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${COLS}`,
          [ctx.businessId, b.title, b.kind, b.body, b.status, owner, b.review_frequency],
        );
        await tx`INSERT INTO sops_versions (business_id, document_id, version, title, body, note, changed_by) VALUES (${ctx.businessId}, ${r.id}, 1, ${b.title}, ${b.body}, 'Created', ${ctx.userId})`;
        return r;
      });
      return json({ document: out(row) }, 201);
    },
    "GET documents/:id": async (ctx, _req, p) => {
      const r = await getDoc(ctx, p.id);
      const versions = await ctx.sql<{ version: number; title: string; note: string; changed_by: string; created_at: Date }[]>`
        SELECT version, title, note, changed_by, created_at FROM sops_versions WHERE document_id = ${r.id} AND business_id = ${ctx.businessId} ORDER BY version DESC LIMIT 100`;
      return json({ document: out(r), versions: versions.map((v) => ({ version: v.version, title: v.title, note: v.note, changedBy: v.changed_by, createdAt: v.created_at.toISOString() })) });
    },
    "PUT documents/:id": async (ctx, req, p) => {
      requireWrite(ctx);
      const patch = await readJson(req, DocPatch);
      const cur = await getDoc(ctx, p.id);
      if (patch.owner && !(await isMember(ctx, patch.owner))) throw new HttpError(400, "owner: must be a member of this business");
      const title = patch.title ?? cur.title;
      const body = patch.body ?? cur.body;
      const contentChanged = title !== cur.title || body !== cur.body;
      const version = contentChanged ? cur.version + 1 : cur.version;
      const row = await ctx.sql.begin(async (tx) => {
        const [r] = await tx.unsafe<Row[]>(
          `UPDATE sops_documents SET title=$3, kind=$4, body=$5, status=$6, owner=$7, review_frequency=$8, version=$9, updated_at=now()
           WHERE id=$1 AND business_id=$2 RETURNING ${COLS}`,
          [cur.id, ctx.businessId, title, patch.kind ?? cur.kind, body, patch.status ?? cur.status, patch.owner ?? cur.owner, patch.review_frequency ?? cur.review_frequency, version],
        );
        if (contentChanged) await tx`INSERT INTO sops_versions (business_id, document_id, version, title, body, note, changed_by) VALUES (${ctx.businessId}, ${cur.id}, ${version}, ${title}, ${body}, ${patch.note ?? ""}, ${ctx.userId})`;
        return r;
      });
      return json({ document: out(row) });
    },
    "DELETE documents/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const r = await ctx.sql`DELETE FROM sops_documents WHERE id = ${uuidParam(p.id)} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },
    "POST documents/:id/reviewed": async (ctx, _req, p) => {
      requireWrite(ctx);
      await getDoc(ctx, p.id);
      const [r] = await ctx.sql.unsafe<Row[]>(`UPDATE sops_documents SET last_reviewed = $3::date, updated_at = now() WHERE id=$1 AND business_id=$2 RETURNING ${COLS}`, [p.id, ctx.businessId, today()]);
      return json({ document: out(r) });
    },
    "GET documents/:id/versions/:version": async (ctx, _req, p) => {
      const d = await getDoc(ctx, p.id);
      const n = Number(p.version);
      if (!Number.isInteger(n)) throw new HttpError(404, "Not found");
      const [v] = await ctx.sql<{ version: number; title: string; body: string }[]>`SELECT version, title, body FROM sops_versions WHERE document_id = ${d.id} AND business_id = ${ctx.businessId} AND version = ${n}`;
      if (!v) throw new HttpError(404, "Not found");
      return json({ version: v });
    },
    "POST documents/:id/restore": async (ctx, req, p) => {
      requireWrite(ctx);
      const { version } = await readJson(req, z.object({ version: z.number().int().min(1) }));
      const cur = await getDoc(ctx, p.id);
      const [v] = await ctx.sql<{ title: string; body: string }[]>`SELECT title, body FROM sops_versions WHERE document_id = ${cur.id} AND business_id = ${ctx.businessId} AND version = ${version}`;
      if (!v) throw new HttpError(404, "That version does not exist");
      const next = cur.version + 1;
      const row = await ctx.sql.begin(async (tx) => {
        const [r] = await tx.unsafe<Row[]>(`UPDATE sops_documents SET title=$3, body=$4, version=$5, updated_at=now() WHERE id=$1 AND business_id=$2 RETURNING ${COLS}`, [cur.id, ctx.businessId, v.title, v.body, next]);
        await tx`INSERT INTO sops_versions (business_id, document_id, version, title, body, note, changed_by) VALUES (${ctx.businessId}, ${cur.id}, ${next}, ${v.title}, ${v.body}, ${`Restored version ${version}`}, ${ctx.userId})`;
        return r;
      });
      return json({ document: out(row) });
    },

    // Deterministic SOP formatter: works without AI.
    "POST sop/format": async (_ctx, req) => {
      const form = await readJson(req, SopForm);
      return json(formatSop(form, { date: today() }));
    },
    // Fill-in templates (proposal, quote, policy, ...) from the business profile.
    "POST generate": async (ctx, req) => {
      const b = await readJson(req, GenBody);
      return json(generateDocument(b.kind, b.fields, profileOf(ctx), today()));
    },

    // AI: starts a job, the UI polls ai/:jobId. Output is a draft, never saved automatically.
    "POST ai": async (ctx, req) => {
      requireWrite(ctx);
      const b = await readJson(req, AiBody);
      if (!ctx.ai.available) throw new HttpError(503, "AI is not available right now. Use the form or a template instead.");
      if (b.action === "draft_sop" && !b.process?.trim()) throw new HttpError(400, "process: describe the process to draft");
      if (b.action !== "draft_sop" && !b.body?.trim()) throw new HttpError(400, "body: there is nothing to work on yet");
      const bc = await ctx.context();
      await ctx.useQuota("ai_request");
      const { jobId } = await ctx.ai.start({
        system: AI_SYSTEM,
        prompt: buildPrompt(b.action, bc.asText(), { process: b.process, notes: b.notes, body: b.body, kind: b.kind ? KIND_LABEL[b.kind] : undefined }),
        tier: b.action === "polish" ? "fast" : "deep",
      });
      return json({ jobId }, 202);
    },
    "GET ai/:jobId": async (ctx, _req, p) => {
      if (p.jobId.length > 200) throw new HttpError(404, "Not found");
      const s = await ctx.ai.poll(p.jobId);
      if (s.state === "done") return json({ state: "done", text: cleanAiText(s.text), label: "AI draft, review before use" });
      return json(s);
    },
  }),

  async Page({ ctx, path }) {
    if (path[0] && UUID_RE.test(path[0])) {
      const r = await ctx.sql.unsafe<Row[]>(`SELECT ${COLS} FROM sops_documents WHERE id = $1 AND business_id = $2`, [path[0], ctx.businessId]);
      if (!r[0]) return <p className="p-6 text-slate-300">Document not found. <a className="underline" href="/app/t/sops">Back to documents</a></p>;
      return <DocEditor initial={out(r[0])} canWrite={ctx.canWrite} aiAvailable={ctx.ai.available} />;
    }
    const rows = await ctx.sql.unsafe<Row[]>(`SELECT ${COLS} FROM sops_documents WHERE business_id = $1 ORDER BY updated_at DESC LIMIT 500`, [ctx.businessId]);
    return <SopsHome initial={rows.map((r) => out(r, false))} canWrite={ctx.canWrite} aiAvailable={ctx.ai.available} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const rows = await ctx.sql<Row[]>`
      SELECT id, title, review_frequency, last_reviewed::text AS last_reviewed, created_at FROM sops_documents
      WHERE business_id = ${ctx.businessId} AND status = 'active' AND review_frequency <> 'none'`;
    const now = today();
    return rows
      .map((r) => ({ r, due: nextReviewDate(r.review_frequency, r.last_reviewed, r.created_at.toISOString()) }))
      .filter((x): x is { r: Row; due: string } => !!x.due && x.due < now)
      .sort((a, b) => a.due.localeCompare(b.due))
      .slice(0, 10)
      .map(({ r, due }) => ({ id: `sops-review-${r.id}`, title: `Review "${r.title}"`, detail: `Was due for review on ${due}.`, severity: "review" as const, href: `/app/t/sops/${r.id}`, dueDate: due }));
  },

  async describe(ctx) {
    const rows = await ctx.sql<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM sops_documents WHERE business_id = ${ctx.businessId} AND status <> 'archived' GROUP BY kind ORDER BY n DESC`;
    if (rows.length === 0) return "";
    const total = rows.reduce((a, r) => a + r.n, 0);
    const kinds = rows.map((r) => `${r.n} ${(KIND_LABEL[r.kind as DocKind] ?? r.kind).toLowerCase()}`).join(", ");
    const titles = await ctx.sql<{ title: string }[]>`SELECT title FROM sops_documents WHERE business_id = ${ctx.businessId} AND status = 'active' AND kind = 'sop' ORDER BY updated_at DESC LIMIT 5`;
    const t = `${total} documented item${total === 1 ? "" : "s"} (${kinds}).${titles.length ? ` Active SOPs include: ${titles.map((x) => x.title).join("; ")}.` : ""}`;
    return t.length > 600 ? `${t.slice(0, 597)}...` : t;
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [r] = await ctx.sql<{ title: string }[]>`SELECT title FROM sops_documents WHERE id = ${id} AND business_id = ${ctx.businessId}`;
    return r ? { title: r.title, href: `/app/t/sops/${id}` } : null;
  },

  async search(ctx, query, limit) {
    const like = "%" + query.replace(/[\\%_]/g, "") + "%";
    const rows = await ctx.sql<{ id: string; title: string; kind: string }[]>`
      SELECT id, title, kind FROM sops_documents WHERE business_id = ${ctx.businessId} AND (title ILIKE ${like} OR body ILIKE ${like}) ORDER BY updated_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.title, snippet: KIND_LABEL[r.kind as DocKind] ?? r.kind, href: `/app/t/sops/${r.id}` }));
  },

  async facts(ctx) {
    const rows = await ctx.sql<{ title: string; kind: string; status: string; updated_at: Date }[]>`
      SELECT title, kind, status, updated_at FROM sops_documents WHERE business_id = ${ctx.businessId} AND status <> 'archived'`;
    const byKind: Record<string, number> = {};
    for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    const titles = rows.map((r) => r.title);
    const kw = detectKeywords(titles);
    return {
      sopCount: byKind.sop ?? 0,
      byKind,
      ...kw,
      hasCustomerOnboarding: kw.hasCustomerOnboarding || rows.some((r) => r.kind === "onboarding" && /\b(customer|client)\b/i.test(r.title)),
      lastUpdated: rows.length ? new Date(Math.max(...rows.map((r) => r.updated_at.getTime()))).toISOString() : null,
    };
  },
};
