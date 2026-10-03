import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, uuidParam, type AttentionItem, type ToolContext, type ToolDef } from "@founderos/sdk";
import { checkClaims, FLAG_NOTE } from "./guard";
import { buildBrandPrompt, buildGenerationPrompt, cleanAiText, DEFAULT_TONE, EMPTY_BRAND, KIND_LABEL, KINDS, parseBrandSuggestion, SYSTEM, TONES, userSources, type Brand, type GenInput, type ItemKind } from "./prompts";
import MarketingApp from "./ui/MarketingApp";
import ItemEditor from "./ui/ItemEditor";

const STATUSES = ["draft", "ready", "published"] as const;
const Str = (max: number) => z.string().max(max);
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s, "not a real date");

const BrandBody = z.object({
  voice: Str(3000).default(""), audience: Str(3000).default(""), offers: Str(3000).default(""), doWords: Str(1000).default(""), dontWords: Str(1000).default(""),
  tone: z.object(Object.fromEntries(TONES.map((t) => [t, z.number().int().min(0).max(100).default(50)])) as Record<(typeof TONES)[number], z.ZodDefault<z.ZodNumber>>).default({ ...DEFAULT_TONE }),
});
const GenBody = z.object({
  kind: z.enum(KINDS), topic: z.string().trim().min(3).max(1000), channel: Str(100).optional(), details: Str(4000).optional(),
  reviewText: Str(3000).optional(), rating: Str(10).optional(), weeks: z.number().int().min(1).max(12).optional(),
});
const SuggestBody = z.object({ notes: Str(2000).default("") });
const ItemBody = z.object({
  kind: z.enum(KINDS), title: z.string().trim().min(1).max(200), body: Str(100_000).default(""), channel: Str(100).default(""),
  status: z.enum(STATUSES).default("draft"), scheduled_for: DateStr.nullable().default(null), notes: Str(5000).default(""),
});
const ItemPatch = ItemBody.partial();

interface BrandRow { voice: string; audience: string; offers: string; do_words: string; dont_words: string; tone: Brand["tone"] }
const brandOut = (r: BrandRow): Brand => ({ voice: r.voice, audience: r.audience, offers: r.offers, doWords: r.do_words, dontWords: r.dont_words, tone: { ...DEFAULT_TONE, ...r.tone } });
async function loadBrand(ctx: ToolContext): Promise<Brand | null> {
  const [r] = await ctx.sql<BrandRow[]>`SELECT voice, audience, offers, do_words, dont_words, tone FROM marketing_brand WHERE business_id = ${ctx.businessId}`;
  return r ? brandOut(r) : null;
}
const hasVoice = (b: Brand | null) => !!b && b.voice.trim().length > 0;

interface ItemRow { id: string; kind: ItemKind; title: string; body: string; channel: string; status: (typeof STATUSES)[number]; scheduled_for: string | null; notes: string; created_at: Date; updated_at: Date }
const ICOLS = `id, kind, title, body, channel, status, scheduled_for::text AS scheduled_for, notes, created_at, updated_at`;
const itemOut = (r: ItemRow, withBody = true) => ({
  id: r.id, kind: r.kind, title: r.title, ...(withBody ? { body: r.body } : {}), channel: r.channel, status: r.status, scheduledFor: r.scheduled_for, notes: r.notes,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});
async function getItem(ctx: ToolContext, id: string): Promise<ItemRow> {
  const [r] = await ctx.sql.unsafe<ItemRow[]>(`SELECT ${ICOLS} FROM marketing_items WHERE id = $1 AND business_id = $2`, [uuidParam(id), ctx.businessId]);
  if (!r) throw new HttpError(404, "Not found");
  return r;
}

/** Everything the user supplied; claims in AI output must be traceable to this. */
function sourceTexts(ctx: ToolContext, brand: Brand | null, userInput: string): string[] {
  const b = ctx.business;
  return [userInput, brand ? [brand.voice, brand.audience, brand.offers, brand.doWords, brand.dontWords].join("\n") : "", [b.name, b.description, b.industry, b.city, b.state, b.website].join("\n")];
}

async function startJob(ctx: ToolContext, kind: string, input: string, prompt: (businessText: string) => string, tier: "fast" | "deep") {
  if (!ctx.ai.available) throw new HttpError(503, "AI is not available right now. You can still write and save copy by hand.");
  const bc = await ctx.context();
  const { jobId } = await ctx.ai.start({ system: SYSTEM, prompt: prompt(bc.asText()), tier });
  const [row] = await ctx.sql<{ id: string }[]>`INSERT INTO marketing_jobs (business_id, ai_job_id, kind, input, created_by) VALUES (${ctx.businessId}, ${jobId}, ${kind}, ${input}, ${ctx.userId}) RETURNING id`;
  return row.id;
}

export const tool: ToolDef = {
  id: "marketing",
  name: "Marketing",
  description: "Brand voice plus AI-assisted social posts, emails, landing copy and ad copy that sound like your business. Drafts only: no posting, no analytics.",
  group: "growth",
  status: "live",
  migrations: [
    {
      name: "0001_marketing",
      sql: `CREATE TABLE marketing_brand (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
        voice       text NOT NULL DEFAULT '',
        audience    text NOT NULL DEFAULT '',
        offers      text NOT NULL DEFAULT '',
        do_words    text NOT NULL DEFAULT '',
        dont_words  text NOT NULL DEFAULT '',
        tone        jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_by  text NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE marketing_items (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        kind          text NOT NULL,
        title         text NOT NULL,
        body          text NOT NULL DEFAULT '',
        channel       text NOT NULL DEFAULT '',
        status        text NOT NULL DEFAULT 'draft',
        scheduled_for date,
        notes         text NOT NULL DEFAULT '',
        created_by    text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX marketing_items_business ON marketing_items (business_id, updated_at DESC);
      CREATE INDEX marketing_items_schedule ON marketing_items (business_id, scheduled_for) WHERE scheduled_for IS NOT NULL;
      CREATE TABLE marketing_jobs (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        ai_job_id   text NOT NULL,
        kind        text NOT NULL,
        input       text NOT NULL DEFAULT '',
        created_by  text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX marketing_jobs_business ON marketing_jobs (business_id, created_at DESC);`,
    },
  ],

  api: route({
    "GET brand": async (ctx) => {
      const b = await loadBrand(ctx);
      return json({ brand: b ?? EMPTY_BRAND, saved: !!b });
    },
    "PUT brand": async (ctx, req) => {
      requireWrite(ctx);
      const b = await readJson(req, BrandBody);
      await ctx.sql`
        INSERT INTO marketing_brand (business_id, voice, audience, offers, do_words, dont_words, tone, updated_by)
        VALUES (${ctx.businessId}, ${b.voice}, ${b.audience}, ${b.offers}, ${b.doWords}, ${b.dontWords}, ${ctx.sql.json(b.tone)}, ${ctx.userId})
        ON CONFLICT (business_id) DO UPDATE SET voice = EXCLUDED.voice, audience = EXCLUDED.audience, offers = EXCLUDED.offers, do_words = EXCLUDED.do_words,
          dont_words = EXCLUDED.dont_words, tone = EXCLUDED.tone, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      return json({ brand: await loadBrand(ctx) });
    },
    "POST brand/suggest": async (ctx, req) => {
      requireWrite(ctx);
      const b = await readJson(req, SuggestBody);
      const id = await startJob(ctx, "brand_suggest", b.notes, (bt) => buildBrandPrompt(bt, b.notes), "fast");
      return json({ id }, 202);
    },
    "POST generate": async (ctx, req) => {
      requireWrite(ctx);
      const b = await readJson(req, GenBody);
      const brand = (await loadBrand(ctx)) ?? EMPTY_BRAND;
      const input: GenInput = { ...b };
      const id = await startJob(ctx, b.kind, userSources(input), (bt) => buildGenerationPrompt(bt, brand, input), b.kind === "landing_copy" || b.kind === "content_calendar" || b.kind === "blog_outline" ? "deep" : "fast");
      return json({ id }, 202);
    },
    "GET jobs/:id": async (ctx, _req, p) => {
      const [job] = await ctx.sql<{ ai_job_id: string; kind: string; input: string }[]>`SELECT ai_job_id, kind, input FROM marketing_jobs WHERE id = ${uuidParam(p.id)} AND business_id = ${ctx.businessId}`;
      if (!job) throw new HttpError(404, "Not found");
      const s = await ctx.ai.poll(job.ai_job_id);
      if (s.state !== "done") return json(s);
      const text = cleanAiText(s.text);
      const flags = checkClaims(text, sourceTexts(ctx, await loadBrand(ctx), job.input));
      return json({
        state: "done", text, kind: job.kind, label: "AI draft, review before use", flags, warning: flags.length ? FLAG_NOTE : null,
        ...(job.kind === "brand_suggest" ? { suggestion: parseBrandSuggestion(text) } : {}),
      });
    },

    "GET items": async (ctx, req) => {
      const u = new URL(req.url).searchParams;
      const kind = u.get("kind");
      const useKind = !!kind && (KINDS as readonly string[]).includes(kind);
      const rows = await ctx.sql.unsafe<ItemRow[]>(
        `SELECT ${ICOLS} FROM marketing_items WHERE business_id = $1 ${useKind ? "AND kind = $2" : ""} ORDER BY updated_at DESC LIMIT 500`,
        useKind ? [ctx.businessId, kind] : [ctx.businessId],
      );
      return json({ items: rows.map((r) => itemOut(r, false)) });
    },
    "POST items": async (ctx, req) => {
      requireWrite(ctx);
      const b = await readJson(req, ItemBody);
      const [r] = await ctx.sql.unsafe<ItemRow[]>(
        `INSERT INTO marketing_items (business_id, kind, title, body, channel, status, scheduled_for, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9) RETURNING ${ICOLS}`,
        [ctx.businessId, b.kind, b.title, b.body, b.channel, b.status, b.scheduled_for, b.notes, ctx.userId],
      );
      return json({ item: itemOut(r) }, 201);
    },
    "GET items/:id": async (ctx, _req, p) => json({ item: itemOut(await getItem(ctx, p.id)) }),
    "PUT items/:id": async (ctx, req, p) => {
      requireWrite(ctx);
      const patch = await readJson(req, ItemPatch);
      const cur = await getItem(ctx, p.id);
      const n = { kind: cur.kind, title: cur.title, body: cur.body, channel: cur.channel, status: cur.status, scheduled_for: cur.scheduled_for, notes: cur.notes, ...patch };
      const [r] = await ctx.sql.unsafe<ItemRow[]>(
        `UPDATE marketing_items SET kind=$3, title=$4, body=$5, channel=$6, status=$7, scheduled_for=$8::date, notes=$9, updated_at=now() WHERE id=$1 AND business_id=$2 RETURNING ${ICOLS}`,
        [cur.id, ctx.businessId, n.kind, n.title, n.body, n.channel, n.status, n.scheduled_for, n.notes],
      );
      return json({ item: itemOut(r) });
    },
    "DELETE items/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const r = await ctx.sql`DELETE FROM marketing_items WHERE id = ${uuidParam(p.id)} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },
    // Stored dates only. Nothing is posted anywhere.
    "GET calendar": async (ctx) => {
      const rows = await ctx.sql.unsafe<ItemRow[]>(`SELECT ${ICOLS} FROM marketing_items WHERE business_id = $1 AND scheduled_for IS NOT NULL ORDER BY scheduled_for, created_at LIMIT 500`, [ctx.businessId]);
      return json({ items: rows.map((r) => itemOut(r, false)), note: "Dates are reminders stored here. Nothing is posted for you." });
    },
  }),

  async Page({ ctx, path }) {
    const aiAvailable = ctx.ai.available;
    if (path[0] === "items" && path[1] && UUID_RE.test(path[1])) {
      const [r] = await ctx.sql.unsafe<ItemRow[]>(`SELECT ${ICOLS} FROM marketing_items WHERE id = $1 AND business_id = $2`, [path[1], ctx.businessId]);
      if (!r) return <p className="p-6 text-slate-300">Item not found. <a className="underline" href="/app/t/marketing">Back to Marketing</a></p>;
      return <ItemEditor initial={itemOut(r)} canWrite={ctx.canWrite} />;
    }
    const brand = await loadBrand(ctx);
    const rows = await ctx.sql.unsafe<ItemRow[]>(`SELECT ${ICOLS} FROM marketing_items WHERE business_id = $1 ORDER BY updated_at DESC LIMIT 500`, [ctx.businessId]);
    return <MarketingApp brand={brand ?? EMPTY_BRAND} brandSaved={!!brand} items={rows.map((r) => itemOut(r, false))} canWrite={ctx.canWrite} aiAvailable={aiAvailable} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    if (!ctx.business.operations.hasCustomers) return [];
    if (hasVoice(await loadBrand(ctx))) return [];
    return [{ id: "marketing-no-brand-voice", title: "Describe your brand voice", detail: "You have customers but no brand voice yet. A short description makes every draft sound like you.", severity: "info", href: "/app/t/marketing" }];
  },

  async describe(ctx) {
    const brand = await loadBrand(ctx);
    const counts = await ctx.sql<{ kind: string; n: number }[]>`SELECT kind, count(*)::int AS n FROM marketing_items WHERE business_id = ${ctx.businessId} GROUP BY kind ORDER BY n DESC`;
    if (!hasVoice(brand) && counts.length === 0) return "";
    const parts: string[] = [];
    if (hasVoice(brand)) parts.push(`Brand voice: ${brand!.voice.trim().slice(0, 250)}${brand!.audience.trim() ? ` Audience: ${brand!.audience.trim().slice(0, 120)}.` : ""}`);
    else parts.push("No brand voice set yet.");
    if (counts.length) parts.push(`Saved marketing drafts: ${counts.map((c) => `${c.n} ${KIND_LABEL[c.kind as ItemKind]?.toLowerCase() ?? c.kind}`).join(", ")}.`);
    const t = parts.join(" ");
    return t.length > 600 ? `${t.slice(0, 597)}...` : t;
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [r] = await ctx.sql<{ title: string }[]>`SELECT title FROM marketing_items WHERE id = ${id} AND business_id = ${ctx.businessId}`;
    return r ? { title: r.title, href: `/app/t/marketing/items/${id}` } : null;
  },

  async search(ctx, query, limit) {
    const like = "%" + query.replace(/[\\%_]/g, "") + "%";
    const rows = await ctx.sql<{ id: string; title: string; kind: string }[]>`
      SELECT id, title, kind FROM marketing_items WHERE business_id = ${ctx.businessId} AND (title ILIKE ${like} OR body ILIKE ${like}) ORDER BY updated_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.title, snippet: KIND_LABEL[r.kind as ItemKind] ?? r.kind, href: `/app/t/marketing/items/${r.id}` }));
  },

  async facts(ctx) {
    const brand = await loadBrand(ctx);
    const rows = await ctx.sql<{ kind: string; status: string; title: string; notes: string }[]>`SELECT kind, status, title, notes FROM marketing_items WHERE business_id = ${ctx.businessId}`;
    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    for (const r of rows) { byKind[r.kind] = (byKind[r.kind] ?? 0) + 1; byStatus[r.status] = (byStatus[r.status] ?? 0) + 1; }
    return {
      hasBrandVoice: hasVoice(brand),
      itemCounts: { total: rows.length, byKind, byStatus },
      hasFollowUpEmail: rows.some((r) => r.kind === "email" && /follow[- ]?up/i.test(`${r.title} ${r.notes}`)),
    };
  },
};
