import { isIP } from "node:net";
import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, uuidParam, type AttentionItem, type ToolContext, type ToolDef } from "@founderos/sdk";
import {
  analysisPrompt, ANALYSIS_SYSTEM, discoverPrompt, parseAnalysis, parseSuggestions, reportPrompt, REPORT_SYSTEM,
  type AnalysisForReport, type Claim, type ParsedAnalysis,
} from "./ai";
import { sameSite } from "./html";
import { MAX_PAGES, researchSite, type PageResult } from "./research";
import { FetchBlocked, isPublicIp, normalizeFetchUrl, realNet, type NetDeps } from "./safe-fetch";
import CompetitorsApp from "./ui/CompetitorsApp";

/** Replaceable in tests so nothing touches the network. */
export const deps = {
  net: realNet as NetDeps,
  fetch: ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
  now: () => new Date(),
  /** Outbound page requests per business per hour (robots.txt requests count too). */
  hourlyLimit: 120,
  /** Minimum time between two research runs of the same competitor. */
  cooldownMs: 30_000,
};

const searchKey = () => process.env.SEARCH_API_KEY?.trim() || null;

const Name = z.string().trim().min(1).max(120);
const AddBody = z.object({ name: Name, url: z.string().trim().min(3).max(500), notes: z.string().trim().max(2000).optional(), source: z.enum(["manual", "search", "ai_suggestion"]).default("manual") });
const PatchBody = z.object({ name: Name.optional(), notes: z.string().trim().max(2000).optional() });
const PageBody = z.object({ url: z.string().trim().min(3).max(500) });
const DiscoverBody = z.object({ query: z.string().trim().max(200).optional() });

interface Item { id: string; name: string; url: string; notes: string; source: string; status: string; last_error: string | null; last_fetched_at: Date | null; created_at: Date }
interface PageRow { id: string; url: string; user_added: boolean; status: string; error: string | null; title: string; description: string; text_excerpt: string; content_hash: string | null; fetched_at: Date | null; prev_fetched_at: Date | null; changed: boolean }
interface AnalysisRow { id: string; competitor_id: string; result: Stored; ai_summary: string | null; ai_job_id: string | null; ai_state: string; ai_error: string | null; created_at: Date }
interface ReportRow { id: string; result: { competitors: { id: string; name: string; analysisId: string; analysedAt: string }[] }; ai_summary: string | null; ai_job_id: string | null; ai_state: string; ai_error: string | null; created_at: Date }
interface Source { url: string; fetched_at: string; hash: string; title: string; text: string }
interface Stored extends Partial<ParsedAnalysis> { sources: Source[]; failed: string[] }

const itemOut = (i: Item) => ({ id: i.id, name: i.name, url: i.url, notes: i.notes, source: i.source, status: i.status, lastError: i.last_error, lastFetchedAt: i.last_fetched_at?.toISOString() ?? null, createdAt: i.created_at.toISOString() });
const pageOut = (p: PageRow) => ({
  id: p.id, url: p.url, userAdded: p.user_added, status: p.status, error: p.error, title: p.title, description: p.description,
  excerpt: p.text_excerpt.slice(0, 500), fetchedAt: p.fetched_at?.toISOString() ?? null, changed: p.changed, previousFetchedAt: p.prev_fetched_at?.toISOString() ?? null,
});
const analysisOut = (a: AnalysisRow) => ({
  id: a.id, createdAt: a.created_at.toISOString(), state: a.ai_state, error: a.ai_error, aiSummary: a.ai_summary,
  sources: (a.result.sources ?? []).map((s) => ({ url: s.url, fetchedAt: s.fetched_at, hash: s.hash, title: s.title })),
  failed: a.result.failed ?? [], parsed: a.result.parsed ?? null, claims: a.result.claims ?? [], rejected: a.result.rejected ?? [], comparison: a.result.comparison ?? null,
});
const reportOut = (r: ReportRow) => ({ id: r.id, createdAt: r.created_at.toISOString(), state: r.ai_state, error: r.ai_error, text: r.ai_summary, competitors: r.result.competitors ?? [] });

async function getItem(ctx: ToolContext, id: string): Promise<Item> {
  const [i] = await ctx.sql<Item[]>`SELECT id, name, url, notes, source, status, last_error, last_fetched_at, created_at FROM competitors_items WHERE id = ${uuidParam(id)} AND business_id = ${ctx.businessId}`;
  if (!i) throw new HttpError(404, "Not found");
  return i;
}
const getPages = (ctx: ToolContext, competitorId: string) => ctx.sql<PageRow[]>`
  SELECT id, url, user_added, status, error, title, description, text_excerpt, content_hash, fetched_at, prev_fetched_at, changed FROM competitors_pages
  WHERE competitor_id = ${competitorId} AND business_id = ${ctx.businessId} ORDER BY user_added DESC, url`;

/** A URL the user typed: normalised (http upgraded to https) and refused if it is obviously not a public website. No request is made here. */
function cleanUrl(raw: string): string {
  const input = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = normalizeFetchUrl(input);
    const bare = u.hostname.replace(/^\[|\]$/g, "");
    if (isIP(bare) !== 0 && !isPublicIp(bare)) throw new FetchBlocked("private", "That address points to a private network");
    const path = u.pathname === "/" ? "/" : u.pathname.replace(/\/+$/, "");
    return `https://${u.host}${path}${u.search}`;
  } catch (e) {
    throw new HttpError(400, e instanceof FetchBlocked ? e.message : "That is not a valid web address");
  }
}

/** Every outbound request is counted so one business cannot hammer other people's sites. */
function metered(ctx: ToolContext): NetDeps {
  return {
    resolve: (h) => deps.net.resolve(h),
    async request(o) {
      await ctx.sql`INSERT INTO competitors_fetch_log (business_id, at) VALUES (${ctx.businessId}, ${deps.now()})`;
      return deps.net.request(o);
    },
  };
}
async function checkRate(ctx: ToolContext): Promise<void> {
  await ctx.sql`DELETE FROM competitors_fetch_log WHERE at < ${new Date(deps.now().getTime() - 86_400_000)}`;
  const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM competitors_fetch_log WHERE business_id = ${ctx.businessId} AND at > ${new Date(deps.now().getTime() - 3_600_000)}`;
  if (n + MAX_PAGES + 2 > deps.hourlyLimit) throw new HttpError(429, "Research limit for this hour reached. Try again later.");
}

async function savePage(ctx: ToolContext, competitorId: string, p: PageResult): Promise<void> {
  if (p.status === "ok") {
    await ctx.sql`
      INSERT INTO competitors_pages (business_id, competitor_id, url, user_added, status, error, title, description, text_excerpt, content_hash, fetched_at)
      VALUES (${ctx.businessId}, ${competitorId}, ${p.url}, ${p.userAdded}, 'ok', NULL, ${p.title}, ${p.description}, ${p.text}, ${p.hash}, ${p.fetchedAt})
      ON CONFLICT (competitor_id, url) DO UPDATE SET
        prev_hash = competitors_pages.content_hash, prev_fetched_at = competitors_pages.fetched_at,
        changed = competitors_pages.content_hash IS NOT NULL AND competitors_pages.content_hash <> EXCLUDED.content_hash,
        status = 'ok', error = NULL, title = EXCLUDED.title, description = EXCLUDED.description, text_excerpt = EXCLUDED.text_excerpt,
        content_hash = EXCLUDED.content_hash, fetched_at = EXCLUDED.fetched_at, user_added = competitors_pages.user_added OR EXCLUDED.user_added`;
  } else {
    await ctx.sql`
      INSERT INTO competitors_pages (business_id, competitor_id, url, user_added, status, error)
      VALUES (${ctx.businessId}, ${competitorId}, ${p.url}, ${p.userAdded}, ${p.status}, ${p.error ?? null})
      ON CONFLICT (competitor_id, url) DO UPDATE SET status = EXCLUDED.status, error = EXCLUDED.error`;
  }
}

async function listCompetitors(ctx: ToolContext) {
  const items = await ctx.sql<Item[]>`SELECT id, name, url, notes, source, status, last_error, last_fetched_at, created_at FROM competitors_items WHERE business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 200`;
  const pages = await ctx.sql<{ competitor_id: string; ok: number; changed: number; skipped: number }[]>`
    SELECT competitor_id, count(*) FILTER (WHERE status = 'ok')::int AS ok, count(*) FILTER (WHERE changed)::int AS changed, count(*) FILTER (WHERE status <> 'ok')::int AS skipped
    FROM competitors_pages WHERE business_id = ${ctx.businessId} GROUP BY competitor_id`;
  const analyses = await ctx.sql<{ competitor_id: string; ai_state: string; created_at: Date }[]>`
    SELECT DISTINCT ON (competitor_id) competitor_id, ai_state, created_at FROM competitors_analyses WHERE business_id = ${ctx.businessId} ORDER BY competitor_id, created_at DESC`;
  return items.map((i) => {
    const p = pages.find((x) => x.competitor_id === i.id);
    const a = analyses.find((x) => x.competitor_id === i.id);
    return { ...itemOut(i), pagesRead: p?.ok ?? 0, pagesSkipped: p?.skipped ?? 0, pagesChanged: p?.changed ?? 0, analysis: a ? { state: a.ai_state, createdAt: a.created_at.toISOString() } : null };
  });
}

async function competitorDetail(ctx: ToolContext, id: string) {
  const item = await getItem(ctx, id);
  const pages = await getPages(ctx, item.id);
  const analyses = await ctx.sql<AnalysisRow[]>`SELECT id, competitor_id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at FROM competitors_analyses WHERE competitor_id = ${item.id} AND business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 10`;
  return { competitor: itemOut(item), pages: pages.map(pageOut), analyses: analyses.map((a) => ({ id: a.id, createdAt: a.created_at.toISOString(), state: a.ai_state })), latest: analyses[0] ? analysisOut(analyses[0]) : null };
}

async function listReports(ctx: ToolContext) {
  const rows = await ctx.sql<ReportRow[]>`SELECT id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at FROM competitors_reports WHERE business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 10`;
  return rows.map(reportOut);
}

/** Plan feature gate: a plan without competitor research gets a plain 402 (the page shows the message). Plans that omit the flag keep it. */
function requireFeature(ctx: ToolContext) {
  if (ctx.plan.features.competitorResearch === false) throw new HttpError(402, "Competitor research is not included in your plan. See your plan and upgrade options on the billing page.");
}

export const tool: ToolDef = {
  id: "competitors",
  name: "Competitor Research",
  description: "Who else is out there, what they offer, and where you can stand out. Reads public pages politely and keeps every claim tied to its source.",
  group: "growth",
  status: "live",
  migrations: [
    {
      name: "0001_competitors",
      sql: `CREATE TABLE competitors_items (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        name            text NOT NULL,
        url             text NOT NULL,
        notes           text NOT NULL DEFAULT '',
        source          text NOT NULL DEFAULT 'manual',
        status          text NOT NULL DEFAULT 'new',
        last_error      text,
        last_fetched_at timestamptz,
        created_by      text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, url)
      );
      CREATE TABLE competitors_pages (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        competitor_id   uuid NOT NULL REFERENCES competitors_items(id) ON DELETE CASCADE,
        url             text NOT NULL,
        user_added      boolean NOT NULL DEFAULT false,
        status          text NOT NULL DEFAULT 'ok',
        error           text,
        title           text NOT NULL DEFAULT '',
        description     text NOT NULL DEFAULT '',
        text_excerpt    text NOT NULL DEFAULT '',
        content_hash    text,
        fetched_at      timestamptz,
        prev_hash       text,
        prev_fetched_at timestamptz,
        changed         boolean NOT NULL DEFAULT false,
        UNIQUE (competitor_id, url)
      );
      CREATE TABLE competitors_analyses (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        competitor_id uuid NOT NULL REFERENCES competitors_items(id) ON DELETE CASCADE,
        result        jsonb NOT NULL,
        ai_summary    text,
        ai_job_id     text,
        ai_state      text NOT NULL DEFAULT 'running',
        ai_error      text,
        created_at    timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX competitors_analyses_comp ON competitors_analyses (business_id, competitor_id, created_at DESC);
      CREATE TABLE competitors_reports (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        result      jsonb NOT NULL,
        ai_summary  text,
        ai_job_id   text,
        ai_state    text NOT NULL DEFAULT 'running',
        ai_error    text,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE competitors_discoveries (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        query       text NOT NULL,
        ai_job_id   text,
        state       text NOT NULL DEFAULT 'running',
        result      jsonb,
        error       text,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE competitors_fetch_log (
        id          bigserial PRIMARY KEY,
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        at          timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX competitors_fetch_log_biz ON competitors_fetch_log (business_id, at DESC);`,
    },
  ],

  api: route({
    "GET status": async (ctx) => json({ aiAvailable: ctx.ai.available, searchEnabled: searchKey() != null, maxPages: MAX_PAGES, researchIncluded: ctx.plan.features.competitorResearch !== false }),

    "GET competitors": async (ctx) => json({ competitors: await listCompetitors(ctx) }),

    "POST competitors": async (ctx, req) => {
      requireWrite(ctx);
      requireFeature(ctx);
      const b = await readJson(req, AddBody);
      const url = cleanUrl(b.url);
      const [exists] = await ctx.sql`SELECT id FROM competitors_items WHERE business_id = ${ctx.businessId} AND url = ${url}`;
      if (exists) throw new HttpError(409, "This competitor is already listed");
      // Stock limit: checked against the real number of tracked competitors (not recorded). 402 with the plan message when full.
      await ctx.useQuota("competitors");
      const [row] = await ctx.sql<Item[]>`
        INSERT INTO competitors_items (business_id, name, url, notes, source, created_by) VALUES (${ctx.businessId}, ${b.name}, ${url}, ${b.notes ?? ""}, ${b.source}, ${ctx.userId})
        RETURNING id, name, url, notes, source, status, last_error, last_fetched_at, created_at`;
      return json({ competitor: itemOut(row) }, 201);
    },

    "GET competitors/:id": async (ctx, _req, p) => json(await competitorDetail(ctx, p.id)),

    "PATCH competitors/:id": async (ctx, req, p) => {
      requireWrite(ctx);
      const item = await getItem(ctx, p.id);
      const b = await readJson(req, PatchBody);
      const [row] = await ctx.sql<Item[]>`UPDATE competitors_items SET name = ${b.name ?? item.name}, notes = ${b.notes ?? item.notes} WHERE id = ${item.id} AND business_id = ${ctx.businessId} RETURNING id, name, url, notes, source, status, last_error, last_fetched_at, created_at`;
      return json({ competitor: itemOut(row) });
    },

    "DELETE competitors/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const r = await ctx.sql`DELETE FROM competitors_items WHERE id = ${uuidParam(p.id)} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },

    "POST competitors/:id/pages": async (ctx, req, p) => {
      requireWrite(ctx);
      requireFeature(ctx);
      const item = await getItem(ctx, p.id);
      const b = await readJson(req, PageBody);
      const url = cleanUrl(b.url);
      if (!sameSite(url, item.url)) throw new HttpError(400, "Pages must be on the same website as the competitor");
      const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM competitors_pages WHERE competitor_id = ${item.id} AND business_id = ${ctx.businessId} AND user_added`;
      if (n >= MAX_PAGES - 1) throw new HttpError(400, `At most ${MAX_PAGES - 1} extra pages per competitor`);
      await ctx.sql`
        INSERT INTO competitors_pages (business_id, competitor_id, url, user_added, status, error) VALUES (${ctx.businessId}, ${item.id}, ${url}, true, 'pending', NULL)
        ON CONFLICT (competitor_id, url) DO UPDATE SET user_added = true`;
      return json({ pages: (await getPages(ctx, item.id)).map(pageOut) }, 201);
    },

    "DELETE competitors/:id/pages/:pid": async (ctx, _req, p) => {
      requireWrite(ctx);
      const item = await getItem(ctx, p.id);
      const r = await ctx.sql`DELETE FROM competitors_pages WHERE id = ${uuidParam(p.pid)} AND competitor_id = ${item.id} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },

    "POST competitors/:id/fetch": async (ctx, _req, p) => {
      requireWrite(ctx);
      requireFeature(ctx);
      const item = await getItem(ctx, p.id);
      if (item.last_fetched_at && deps.now().getTime() - item.last_fetched_at.getTime() < deps.cooldownMs) throw new HttpError(429, "This competitor was checked moments ago. Wait a little before checking again.");
      await checkRate(ctx);
      const userPages = (await ctx.sql<{ url: string }[]>`SELECT url FROM competitors_pages WHERE competitor_id = ${item.id} AND business_id = ${ctx.businessId} AND user_added`).map((r) => r.url);
      let results: PageResult[];
      try {
        results = await researchSite(item.url, userPages, metered(ctx), deps.now);
      } catch (e) {
        const msg = e instanceof FetchBlocked ? e.message : "The website could not be read";
        await ctx.sql`UPDATE competitors_items SET status = 'error', last_error = ${msg}, last_fetched_at = ${deps.now()} WHERE id = ${item.id} AND business_id = ${ctx.businessId}`;
        throw new HttpError(422, msg);
      }
      for (const r of results) await savePage(ctx, item.id, r);
      const ok = results.filter((r) => r.status === "ok").length;
      const blocked = results.filter((r) => r.status === "blocked_robots").length;
      const firstError = results.find((r) => r.status !== "ok")?.error ?? null;
      const status = ok > 0 ? "fetched" : blocked === results.length ? "blocked" : "error";
      await ctx.sql`UPDATE competitors_items SET status = ${status}, last_error = ${ok > 0 ? null : firstError}, last_fetched_at = ${deps.now()} WHERE id = ${item.id} AND business_id = ${ctx.businessId}`;
      const pages = (await getPages(ctx, item.id)).map(pageOut);
      return json({
        competitor: itemOut(await getItem(ctx, item.id)), pages,
        skipped: results.filter((r) => r.status !== "ok").map((r) => ({ url: r.url, reason: r.error })),
        changed: pages.filter((pg) => pg.changed).map((pg) => pg.url),
      });
    },

    "POST competitors/:id/analyze": async (ctx, _req, p) => {
      requireWrite(ctx);
      requireFeature(ctx);
      const item = await getItem(ctx, p.id);
      if (!ctx.ai.available) throw new HttpError(503, "AI is not available for this business right now. You can still read the fetched pages.");
      const pages = await ctx.sql<{ url: string; title: string; text_excerpt: string; content_hash: string; fetched_at: Date; status: string }[]>`
        SELECT url, title, text_excerpt, content_hash, fetched_at, status FROM competitors_pages WHERE competitor_id = ${item.id} AND business_id = ${ctx.businessId} ORDER BY user_added DESC, url`;
      const ok = pages.filter((x) => x.status === "ok" && x.text_excerpt.trim().length > 0);
      if (ok.length === 0) throw new HttpError(409, "No pages have been read yet. Fetch this competitor's website first.");
      const failed = pages.filter((x) => x.status !== "ok").map((x) => `${x.url} (${x.status === "blocked_robots" ? "skipped: robots.txt" : "could not be fetched"})`);
      const bc = await ctx.context();
      const facts = (await ctx.facts()).product ?? {};
      await ctx.useQuota("ai_request");
      const sources: Source[] = ok.map((x) => ({ url: x.url, fetched_at: x.fetched_at.toISOString(), hash: x.content_hash, title: x.title, text: x.text_excerpt.slice(0, 6000) }));
      const { jobId } = await ctx.ai.start({
        tier: "deep", system: ANALYSIS_SYSTEM,
        prompt: analysisPrompt({ businessText: bc.asText(), productFacts: facts, competitor: { name: item.name, url: item.url }, pages: sources.map((s) => ({ url: s.url, fetchedAt: s.fetched_at, title: s.title, text: s.text })), failed }),
      });
      const result: Stored = { sources, failed };
      const [row] = await ctx.sql<{ id: string }[]>`
        INSERT INTO competitors_analyses (business_id, competitor_id, result, ai_job_id, ai_state) VALUES (${ctx.businessId}, ${item.id}, ${ctx.sql.json(result as never)}, ${jobId}, 'running') RETURNING id`;
      return json({ analysisId: row.id, state: "running" }, 202);
    },

    "GET competitors/:id/analyses/:aid": async (ctx, _req, p) => {
      const item = await getItem(ctx, p.id);
      const [a] = await ctx.sql<AnalysisRow[]>`SELECT id, competitor_id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at FROM competitors_analyses WHERE id = ${uuidParam(p.aid)} AND competitor_id = ${item.id} AND business_id = ${ctx.businessId}`;
      if (!a) throw new HttpError(404, "Not found");
      let cur = a;
      if (a.ai_state === "running" && a.ai_job_id) {
        const st = await ctx.ai.poll(a.ai_job_id);
        if (st.state === "done") {
          const parsed = parseAnalysis(st.text, a.result.sources.map((s) => ({ url: s.url, fetchedAt: s.fetched_at, text: s.text })));
          const result: Stored = { ...a.result, ...parsed };
          [cur] = await ctx.sql<AnalysisRow[]>`UPDATE competitors_analyses SET ai_state = 'done', ai_summary = ${st.text}, result = ${ctx.sql.json(result as never)} WHERE id = ${a.id} AND business_id = ${ctx.businessId} RETURNING id, competitor_id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at`;
        } else if (st.state === "failed") {
          [cur] = await ctx.sql<AnalysisRow[]>`UPDATE competitors_analyses SET ai_state = 'failed', ai_error = ${st.error} WHERE id = ${a.id} AND business_id = ${ctx.businessId} RETURNING id, competitor_id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at`;
        } else {
          return json({ analysis: { ...analysisOut(a), state: st.state, message: st.state === "waiting" ? st.message : undefined } });
        }
      }
      return json({ analysis: analysisOut(cur) });
    },

    "POST report": async (ctx) => {
      requireWrite(ctx);
      requireFeature(ctx);
      if (!ctx.ai.available) throw new HttpError(503, "AI is not available for this business right now.");
      const rows = await ctx.sql<(AnalysisRow & { name: string; url: string })[]>`
        SELECT DISTINCT ON (a.competitor_id) a.id, a.competitor_id, a.result, a.ai_summary, a.ai_job_id, a.ai_state, a.ai_error, a.created_at, i.name, i.url
        FROM competitors_analyses a JOIN competitors_items i ON i.id = a.competitor_id AND i.business_id = a.business_id
        WHERE a.business_id = ${ctx.businessId} AND a.ai_state = 'done' ORDER BY a.competitor_id, a.created_at DESC`;
      const usable = rows.filter((r) => r.result.parsed && (r.result.claims?.length ?? 0) > 0);
      if (usable.length === 0) throw new HttpError(409, "Analyse at least one competitor first. The report only uses sourced claims.");
      const items: AnalysisForReport[] = usable.map((r) => ({ name: r.name, url: r.url, analysedAt: r.created_at.toISOString(), claims: r.result.claims as Claim[], comparison: r.result.comparison ?? null }));
      const bc = await ctx.context();
      await ctx.useQuota("ai_request");
      const { jobId } = await ctx.ai.start({ tier: "deep", system: REPORT_SYSTEM, prompt: reportPrompt(bc.asText(), (await ctx.facts()).product ?? {}, items) });
      const result = { competitors: usable.map((r) => ({ id: r.competitor_id, name: r.name, analysisId: r.id, analysedAt: r.created_at.toISOString() })) };
      const [row] = await ctx.sql<{ id: string }[]>`INSERT INTO competitors_reports (business_id, result, ai_job_id, ai_state) VALUES (${ctx.businessId}, ${ctx.sql.json(result as never)}, ${jobId}, 'running') RETURNING id`;
      return json({ reportId: row.id, state: "running" }, 202);
    },

    "GET reports": async (ctx) => json({ reports: await listReports(ctx) }),

    "GET reports/:rid": async (ctx, _req, p) => {
      const [r] = await ctx.sql<ReportRow[]>`SELECT id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at FROM competitors_reports WHERE id = ${uuidParam(p.rid)} AND business_id = ${ctx.businessId}`;
      if (!r) throw new HttpError(404, "Not found");
      let cur = r;
      if (r.ai_state === "running" && r.ai_job_id) {
        const st = await ctx.ai.poll(r.ai_job_id);
        if (st.state === "done") [cur] = await ctx.sql<ReportRow[]>`UPDATE competitors_reports SET ai_state = 'done', ai_summary = ${st.text} WHERE id = ${r.id} AND business_id = ${ctx.businessId} RETURNING id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at`;
        else if (st.state === "failed") [cur] = await ctx.sql<ReportRow[]>`UPDATE competitors_reports SET ai_state = 'failed', ai_error = ${st.error} WHERE id = ${r.id} AND business_id = ${ctx.businessId} RETURNING id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at`;
        else return json({ report: { ...reportOut(r), state: st.state, message: st.state === "waiting" ? st.message : undefined } });
      }
      return json({ report: reportOut(cur) });
    },

    "POST discover": async (ctx, req) => {
      requireWrite(ctx);
      requireFeature(ctx);
      const b = await readJson(req, DiscoverBody);
      const subject = ctx.business.name;
      const query = b.query || `alternatives to ${subject}`;
      const key = searchKey();
      if (key) {
        // Fixed host; the key is sent only here and never returned or logged.
        const own = ctx.business.website ? (() => { try { return new URL(/^https?:/i.test(ctx.business.website) ? ctx.business.website : `https://${ctx.business.website}`).hostname.replace(/^www\./, ""); } catch { return ""; } })() : "";
        let res: Response;
        try {
          res = await deps.fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`, { headers: { accept: "application/json", "x-subscription-token": key }, redirect: "error", signal: AbortSignal.timeout(15_000) });
        } catch {
          throw new HttpError(502, "The search service could not be reached");
        }
        if (!res.ok) throw new HttpError(502, "The search service did not answer correctly");
        const data = (await res.json().catch(() => ({}))) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
        const results = (data.web?.results ?? []).flatMap((r) => {
          try {
            const u = new URL(r.url ?? "");
            if (u.protocol !== "https:" || u.hostname.replace(/^www\./, "") === own) return [];
            return [{ title: String(r.title ?? u.hostname).slice(0, 150), url: `https://${u.hostname}/`, description: String(r.description ?? "").replace(/<[^>]+>/g, "").slice(0, 250) }];
          } catch { return []; }
        });
        return json({ source: "search", label: "Search results for your query: these are web results, not verified competitors. Check each website.", query, results });
      }
      if (!ctx.ai.available) throw new HttpError(503, "No search service is configured and AI is not available, so suggestions cannot be made. You can still add competitors yourself.");
      const bc = await ctx.context();
      await ctx.useQuota("ai_request");
      const { jobId } = await ctx.ai.start({ tier: "fast", prompt: discoverPrompt(bc.asText(), query) });
      const [row] = await ctx.sql<{ id: string }[]>`INSERT INTO competitors_discoveries (business_id, query, ai_job_id) VALUES (${ctx.businessId}, ${query}, ${jobId}) RETURNING id`;
      return json({ source: "ai", discoveryId: row.id, state: "running" }, 202);
    },

    "GET discover/:did": async (ctx, _req, p) => {
      const [d] = await ctx.sql<{ id: string; query: string; ai_job_id: string | null; state: string; result: unknown; error: string | null }[]>`SELECT id, query, ai_job_id, state, result, error FROM competitors_discoveries WHERE id = ${uuidParam(p.did)} AND business_id = ${ctx.businessId}`;
      if (!d) throw new HttpError(404, "Not found");
      const label = "Unverified suggestion, check the website. These names come from the AI's general knowledge, not from a source.";
      if (d.state === "running" && d.ai_job_id) {
        const st = await ctx.ai.poll(d.ai_job_id);
        if (st.state === "done") {
          const suggestions = parseSuggestions(st.text);
          await ctx.sql`UPDATE competitors_discoveries SET state = 'done', result = ${ctx.sql.json(suggestions as never)} WHERE id = ${d.id} AND business_id = ${ctx.businessId}`;
          return json({ source: "ai", state: "done", label, suggestions });
        }
        if (st.state === "failed") {
          await ctx.sql`UPDATE competitors_discoveries SET state = 'failed', error = ${st.error} WHERE id = ${d.id} AND business_id = ${ctx.businessId}`;
          return json({ source: "ai", state: "failed", error: st.error });
        }
        return json({ source: "ai", state: st.state, message: st.state === "waiting" ? st.message : undefined });
      }
      return json({ source: "ai", state: d.state, label, suggestions: d.result ?? [], error: d.error });
    },
  }),

  async Page({ ctx, path }) {
    const common = { canWrite: ctx.canWrite, aiAvailable: ctx.ai.available, searchEnabled: searchKey() != null, businessName: ctx.business.name, researchIncluded: ctx.plan.features.competitorResearch !== false };
    if (path[0]) {
      if (!UUID_RE.test(path[0])) return <p className="p-6 text-slate-300">Not found.</p>;
      const [r] = await ctx.sql<{ id: string }[]>`SELECT id FROM competitors_items WHERE id = ${path[0]} AND business_id = ${ctx.businessId}`;
      if (!r) return <p className="p-6 text-slate-300">Not found.</p>;
      return <CompetitorsApp {...common} competitorId={r.id} initialDetail={await competitorDetail(ctx, r.id)} />;
    }
    return <CompetitorsApp {...common} initialList={await listCompetitors(ctx)} initialReports={await listReports(ctx)} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM competitors_items WHERE business_id = ${ctx.businessId}`;
    if (n === 0 && ctx.business.operations.hasCustomers) {
      items.push({ id: "competitors-none", severity: "info", title: "No competitors researched yet", detail: "You have customers, so it is worth knowing who else they could choose. Add a competitor and let FounderOS read their public pages.", href: "/app/t/competitors" });
    }
    const cutoff = new Date(deps.now().getTime() - 90 * 86_400_000);
    const stale = await ctx.sql<{ id: string; name: string }[]>`
      SELECT i.id, i.name FROM competitors_items i
      WHERE i.business_id = ${ctx.businessId}
        AND (SELECT max(a.created_at) FROM competitors_analyses a WHERE a.competitor_id = i.id AND a.ai_state = 'done') < ${cutoff}
      ORDER BY i.name LIMIT 5`;
    if (stale.length > 0) {
      items.push({ id: "competitors-stale", severity: "info", title: `${stale.length} competitor ${stale.length === 1 ? "analysis is" : "analyses are"} older than 90 days`, detail: `${stale.map((s) => s.name).join(", ")}. Fetch their pages again to see what changed.`, href: "/app/t/competitors" });
    }
    const changed = await ctx.sql<{ id: string; name: string }[]>`
      SELECT DISTINCT i.id, i.name FROM competitors_items i JOIN competitors_pages p ON p.competitor_id = i.id AND p.business_id = i.business_id
      WHERE i.business_id = ${ctx.businessId} AND p.changed ORDER BY i.name LIMIT 3`;
    for (const c of changed) items.push({ id: `competitors-changed-${c.id}`, severity: "info", title: `${c.name}'s website changed since the last check`, href: `/app/t/competitors/${c.id}` });
    return items;
  },

  async describe(ctx) {
    const items = await ctx.sql<{ name: string; last_fetched_at: Date | null }[]>`SELECT name, last_fetched_at FROM competitors_items WHERE business_id = ${ctx.businessId} ORDER BY created_at LIMIT 50`;
    if (items.length === 0) return "";
    const researched = items.filter((i) => i.last_fetched_at);
    const last = researched.map((i) => i.last_fetched_at!.getTime()).sort((a, b) => b - a)[0];
    const names = items.slice(0, 6).map((i) => i.name).join(", ");
    const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(DISTINCT competitor_id)::int AS n FROM competitors_analyses WHERE business_id = ${ctx.businessId} AND ai_state = 'done'`;
    return `Tracking ${items.length} competitor${items.length === 1 ? "" : "s"}: ${names}${items.length > 6 ? ", and more" : ""}. ${researched.length} had their public pages read${last ? ` (latest ${new Date(last).toISOString().slice(0, 10)})` : ""}; ${n} analysed with AI (unverified opinion, sources are stored per claim).`.slice(0, 600);
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [r] = await ctx.sql<{ name: string }[]>`SELECT name FROM competitors_items WHERE id = ${id} AND business_id = ${ctx.businessId}`;
    return r ? { title: r.name, href: `/app/t/competitors/${id}` } : null;
  },

  async search(ctx, query, limit) {
    const like = "%" + query.replace(/[%_\\]/g, "") + "%";
    const rows = await ctx.sql<{ id: string; name: string; url: string }[]>`
      SELECT id, name, url FROM competitors_items WHERE business_id = ${ctx.businessId} AND (name ILIKE ${like} OR url ILIKE ${like} OR notes ILIKE ${like}) ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.name, snippet: r.url, href: `/app/t/competitors/${r.id}` }));
  },

  async facts(ctx) {
    const [{ n, last }] = await ctx.sql<{ n: number; last: Date | null }[]>`SELECT count(*)::int AS n, max(last_fetched_at) AS last FROM competitors_items WHERE business_id = ${ctx.businessId}`;
    const names = await ctx.sql<{ name: string }[]>`SELECT name FROM competitors_items WHERE business_id = ${ctx.businessId} ORDER BY created_at LIMIT 10`;
    return { competitorCount: n, lastResearchAt: last ? last.toISOString() : null, competitors: names.map((r) => r.name) };
  },
};
