import { z } from "zod";
import { HttpError, json, readJson, requireWrite, route, UUID_RE, uuidParam, type AttentionItem, type ToolContext, type ToolDef } from "@founderos/sdk";
import { diffScans } from "./analyze";
import { buildPrompt, deterministicProfile, extractSummaryLine, SYSTEM_PROMPT } from "./ai";
import { parseRepoUrl, RepoUrlError, type RepoRef } from "./repo-url";
import { scanRepository, ScanError, type ScanDeps, type ScanResult } from "./scanner";
import { decryptToken, encryptToken, getSecretKey } from "./token-crypto";
import ProductApp from "./ui/ProductApp";

/** Replaceable in tests so nothing touches the network. */
export const deps: ScanDeps & { minRescanMs: number } = {
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => new Date(),
  minRescanMs: 20_000,
};

const TOKEN_RE = /^[A-Za-z0-9_.=-]{8,300}$/;
const Token = z.string().trim().regex(TOKEN_RE, "That does not look like an access token");
const AddBody = z.object({ url: z.string().min(1).max(300), token: Token.optional() });
const ScanBody = z.object({ token: Token.optional() }).default({});
const TokenBody = z.object({ token: Token });

interface RepoRow {
  id: string; url: string; provider: "github" | "gitlab"; owner: string; name: string; token_enc: string | null;
  last_scanned_at: Date | null; status: string; last_error: string | null; created_at: Date;
}
interface ScanRow { id: string; repo_id: string; result: ScanResult; ai_summary: string | null; ai_job_id: string | null; ai_state: string; ai_error: string | null; created_at: Date }


/** Never include token_enc: the browser only learns whether a token exists. */
const repoOut = (r: RepoRow) => ({
  id: r.id, url: r.url, provider: r.provider, owner: r.owner, name: r.name, hasToken: r.token_enc != null,
  lastScannedAt: r.last_scanned_at?.toISOString() ?? null, status: r.status, lastError: r.last_error, createdAt: r.created_at.toISOString(),
});
const scanBrief = (s: ScanRow) => ({ id: s.id, createdAt: s.created_at.toISOString(), aiState: s.ai_state, hasAi: Boolean(s.ai_summary) });
const scanOut = (s: ScanRow) => ({ ...scanBrief(s), result: s.result, aiSummary: s.ai_summary, aiError: s.ai_error });

async function getRepo(ctx: ToolContext, id: string): Promise<RepoRow> {
  const [r] = await ctx.sql<RepoRow[]>`SELECT id, url, provider, owner, name, token_enc, last_scanned_at, status, last_error, created_at FROM product_repos WHERE id = ${uuidParam(id)} AND business_id = ${ctx.businessId}`;
  if (!r) throw new HttpError(404, "Not found");
  return r;
}
async function getScan(ctx: ToolContext, repoId: string, scanId: string): Promise<ScanRow> {
  const [s] = await ctx.sql<ScanRow[]>`SELECT id, repo_id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at FROM product_scans WHERE id = ${uuidParam(scanId)} AND repo_id = ${repoId} AND business_id = ${ctx.businessId}`;
  if (!s) throw new HttpError(404, "Not found");
  return s;
}

const tokenNote = (stored: boolean, given: boolean) =>
  !given ? null : stored ? "Your access token was saved encrypted. It is never shown again and you can delete it at any time."
    : "Your access token was used for this scan only and was not saved, because this server has no encryption key (FOUNDEROS_SECRET_KEY).";

/** Scan and store the result. The token (if any) is used for this call and never logged or returned. */
async function runScan(ctx: ToolContext, repo: RepoRow, tokenOverride?: string): Promise<ScanRow> {
  const key = getSecretKey();
  let token = tokenOverride;
  if (!token && repo.token_enc && key) token = decryptToken(repo.token_enc, key, ctx.businessId) ?? undefined;
  const ref: RepoRef = { provider: repo.provider, owner: repo.owner, name: repo.name, url: repo.url };
  let result: ScanResult;
  try {
    result = await scanRepository(ref, token, deps);
  } catch (e) {
    const status = e instanceof ScanError ? e.status : 502;
    const message = e instanceof ScanError ? e.message : "The scan failed";
    await ctx.sql`UPDATE product_repos SET status = 'error', last_error = ${message} WHERE id = ${repo.id} AND business_id = ${ctx.businessId}`;
    throw new HttpError(status === 404 || status === 403 || status === 429 ? status : 502, message);
  }
  const [row] = await ctx.sql<ScanRow[]>`
    INSERT INTO product_scans (business_id, repo_id, result) VALUES (${ctx.businessId}, ${repo.id}, ${ctx.sql.json(result as never)})
    RETURNING id, repo_id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at`;
  await ctx.sql`UPDATE product_repos SET status = 'ok', last_error = NULL, last_scanned_at = ${deps.now()} WHERE id = ${repo.id} AND business_id = ${ctx.businessId}`;
  // Keep history, but bounded.
  await ctx.sql`DELETE FROM product_scans WHERE repo_id = ${repo.id} AND business_id = ${ctx.businessId} AND id NOT IN (SELECT id FROM product_scans WHERE repo_id = ${repo.id} AND business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 20)`;
  return row;
}

const parseUrl = (u: string): RepoRef => {
  try {
    return parseRepoUrl(u);
  } catch (e) {
    if (e instanceof RepoUrlError) throw new HttpError(400, e.message);
    throw e;
  }
};

/** Latest successful scan of every linked repository. */
async function latestScans(ctx: ToolContext): Promise<{ repo: RepoRow; scan: ScanRow }[]> {
  const rows = await ctx.sql<(ScanRow & { r_id: string })[]>`
    SELECT DISTINCT ON (s.repo_id) s.id, s.repo_id, s.result, s.ai_summary, s.ai_job_id, s.ai_state, s.ai_error, s.created_at, r.id AS r_id
    FROM product_scans s JOIN product_repos r ON r.id = s.repo_id AND r.business_id = s.business_id
    WHERE s.business_id = ${ctx.businessId} ORDER BY s.repo_id, s.created_at DESC`;
  const repos = await ctx.sql<RepoRow[]>`SELECT id, url, provider, owner, name, token_enc, last_scanned_at, status, last_error, created_at FROM product_repos WHERE business_id = ${ctx.businessId} ORDER BY created_at`;
  return repos.flatMap((repo) => {
    const scan = rows.find((s) => s.repo_id === repo.id);
    return scan ? [{ repo, scan }] : [];
  });
}

async function listRepos(ctx: ToolContext) {
  const repos = await ctx.sql<RepoRow[]>`SELECT id, url, provider, owner, name, token_enc, last_scanned_at, status, last_error, created_at FROM product_repos WHERE business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 100`;
  const latest = await latestScans(ctx);
  return repos.map((r) => {
    const s = latest.find((l) => l.repo.id === r.id)?.scan;
    return { ...repoOut(r), latest: s ? { scanId: s.id, summary: s.ai_summary ? extractSummaryLine(s.ai_summary) : null, analysis: s.result.analysis.signals, stack: [...s.result.analysis.frameworks, ...s.result.analysis.databases] } : null };
  });
}

async function repoDetail(ctx: ToolContext, id: string) {
  const repo = await getRepo(ctx, id);
  const scans = await ctx.sql<ScanRow[]>`SELECT id, repo_id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at FROM product_scans WHERE repo_id = ${repo.id} AND business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 20`;
  return { repo: repoOut(repo), scans: scans.map(scanBrief), latest: scans[0] ? scanOut(scans[0]) : null };
}

export const tool: ToolDef = {
  id: "product",
  name: "Product Scan",
  description: "Link a GitHub or GitLab repository so FounderOS understands what you have built and what it means for your business.",
  group: "business",
  status: "live",
  migrations: [
    {
      name: "0001_product",
      sql: `CREATE TABLE product_repos (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        url             text NOT NULL,
        provider        text NOT NULL,
        owner           text NOT NULL,
        name            text NOT NULL,
        token_enc       text,
        last_scanned_at timestamptz,
        status          text NOT NULL DEFAULT 'new',
        last_error      text,
        created_by      text NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        UNIQUE (business_id, url)
      );
      CREATE TABLE product_scans (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
        repo_id     uuid NOT NULL REFERENCES product_repos(id) ON DELETE CASCADE,
        result      jsonb NOT NULL,
        ai_summary  text,
        ai_job_id   text,
        ai_state    text NOT NULL DEFAULT 'none',
        ai_error    text,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX product_scans_repo ON product_scans (business_id, repo_id, created_at DESC);`,
    },
  ],

  api: route({
    "GET status": async (ctx) => json({ aiAvailable: ctx.ai.available, tokenStorage: getSecretKey() != null }),

    "GET repos": async (ctx) => json({ repos: await listRepos(ctx) }),

    "POST repos": async (ctx, req) => {
      requireWrite(ctx);
      const body = await readJson(req, AddBody);
      const ref = parseUrl(body.url);
      const [exists] = await ctx.sql`SELECT id FROM product_repos WHERE business_id = ${ctx.businessId} AND url = ${ref.url}`;
      if (exists) throw new HttpError(409, "This repository is already linked");
      const key = getSecretKey();
      const [created] = await ctx.sql<RepoRow[]>`
        INSERT INTO product_repos (business_id, url, provider, owner, name, created_by) VALUES (${ctx.businessId}, ${ref.url}, ${ref.provider}, ${ref.owner}, ${ref.name}, ${ctx.userId})
        RETURNING id, url, provider, owner, name, token_enc, last_scanned_at, status, last_error, created_at`;
      let scan: ScanRow;
      try {
        scan = await runScan(ctx, created, body.token);
      } catch (e) {
        await ctx.sql`DELETE FROM product_repos WHERE id = ${created.id} AND business_id = ${ctx.businessId}`;
        throw e;
      }
      // Keep the token only after it worked, and only if we can encrypt it.
      if (body.token && key) await ctx.sql`UPDATE product_repos SET token_enc = ${encryptToken(body.token, key, ctx.businessId)} WHERE id = ${created.id} AND business_id = ${ctx.businessId}`;
      const repo = await getRepo(ctx, created.id);
      return json({ repo: repoOut(repo), scan: scanOut(scan), tokenNote: tokenNote(Boolean(body.token && key), Boolean(body.token)) }, 201);
    },

    "GET repos/:id": async (ctx, _req, p) => json(await repoDetail(ctx, p.id)),

    "DELETE repos/:id": async (ctx, _req, p) => {
      requireWrite(ctx);
      const r = await ctx.sql`DELETE FROM product_repos WHERE id = ${uuidParam(p.id)} AND business_id = ${ctx.businessId}`;
      if (r.count === 0) throw new HttpError(404, "Not found");
      return json({ ok: true });
    },

    "POST repos/:id/scan": async (ctx, req, p) => {
      requireWrite(ctx);
      const repo = await getRepo(ctx, p.id);
      const body = await readJson(req, ScanBody);
      if (repo.last_scanned_at && deps.now().getTime() - repo.last_scanned_at.getTime() < deps.minRescanMs) throw new HttpError(429, "This repository was scanned moments ago. Wait a little before scanning again.");
      const scan = await runScan(ctx, repo, body.token);
      return json({ repo: repoOut(await getRepo(ctx, repo.id)), scan: scanOut(scan), tokenNote: body.token ? "The token was used for this scan only." : null });
    },

    "PUT repos/:id/token": async (ctx, req, p) => {
      requireWrite(ctx);
      const repo = await getRepo(ctx, p.id);
      const body = await readJson(req, TokenBody);
      const key = getSecretKey();
      if (!key) throw new HttpError(409, "This server has no encryption key (FOUNDEROS_SECRET_KEY), so tokens cannot be saved. Paste the token when you scan instead.");
      await ctx.sql`UPDATE product_repos SET token_enc = ${encryptToken(body.token, key, ctx.businessId)} WHERE id = ${repo.id} AND business_id = ${ctx.businessId}`;
      return json({ ok: true, hasToken: true });
    },

    "DELETE repos/:id/token": async (ctx, _req, p) => {
      requireWrite(ctx);
      const repo = await getRepo(ctx, p.id);
      await ctx.sql`UPDATE product_repos SET token_enc = NULL WHERE id = ${repo.id} AND business_id = ${ctx.businessId}`;
      return json({ ok: true, hasToken: false });
    },

    "GET repos/:id/scans/:sid": async (ctx, _req, p) => {
      const repo = await getRepo(ctx, p.id);
      return json({ scan: scanOut(await getScan(ctx, repo.id, p.sid)) });
    },

    "GET repos/:id/compare": async (ctx, req, p) => {
      const repo = await getRepo(ctx, p.id);
      const sp = new URL(req.url).searchParams;
      const rows = await ctx.sql<ScanRow[]>`SELECT id, repo_id, result, ai_summary, ai_job_id, ai_state, ai_error, created_at FROM product_scans WHERE repo_id = ${repo.id} AND business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 20`;
      const to = sp.get("to") ? rows.find((r) => r.id === sp.get("to")) : rows[0];
      const from = sp.get("from") ? rows.find((r) => r.id === sp.get("from")) : rows[1];
      if (!to || !from) throw new HttpError(404, "Two scans are needed to compare");
      const diff = diffScans(from.result, to.result);
      return json({ from: scanBrief(from), to: scanBrief(to), ...diff });
    },

    "POST repos/:id/scans/:sid/ai": async (ctx, _req, p) => {
      requireWrite(ctx);
      const repo = await getRepo(ctx, p.id);
      const scan = await getScan(ctx, repo.id, p.sid);
      if (!ctx.ai.available) throw new HttpError(503, "AI is not available for this business right now. The scan results above are still valid.");
      const bc = await ctx.context();
      const { jobId } = await ctx.ai.start({ tier: "deep", system: SYSTEM_PROMPT, prompt: buildPrompt(scan.result, bc.asText()) });
      await ctx.sql`UPDATE product_scans SET ai_job_id = ${jobId}, ai_state = 'running', ai_error = NULL WHERE id = ${scan.id} AND business_id = ${ctx.businessId}`;
      return json({ state: "running" }, 202);
    },

    "GET repos/:id/scans/:sid/ai": async (ctx, _req, p) => {
      const repo = await getRepo(ctx, p.id);
      const scan = await getScan(ctx, repo.id, p.sid);
      if (scan.ai_state !== "running" || !scan.ai_job_id) return json({ state: scan.ai_state, text: scan.ai_summary, error: scan.ai_error });
      const st = await ctx.ai.poll(scan.ai_job_id);
      if (st.state === "done") {
        await ctx.sql`UPDATE product_scans SET ai_summary = ${st.text}, ai_state = 'done' WHERE id = ${scan.id} AND business_id = ${ctx.businessId}`;
        return json({ state: "done", text: st.text });
      }
      if (st.state === "failed") {
        await ctx.sql`UPDATE product_scans SET ai_state = 'failed', ai_error = ${st.error} WHERE id = ${scan.id} AND business_id = ${ctx.businessId}`;
        return json({ state: "failed", error: st.error });
      }
      return json(st.state === "waiting" ? { state: "waiting", message: st.message } : { state: "running" });
    },
  }),

  async Page({ ctx, path }) {
    const common = { canWrite: ctx.canWrite, aiAvailable: ctx.ai.available, tokenStorage: getSecretKey() != null };
    if (path[0]) {
      if (!UUID_RE.test(path[0])) return <p className="p-6 text-slate-300">Not found.</p>;
      const [r] = await ctx.sql<{ id: string }[]>`SELECT id FROM product_repos WHERE id = ${path[0]} AND business_id = ${ctx.businessId}`;
      if (!r) return <p className="p-6 text-slate-300">Not found.</p>;
      return <ProductApp {...common} repoId={r.id} initialDetail={await repoDetail(ctx, r.id)} />;
    }
    return <ProductApp {...common} initialRepos={await listRepos(ctx)} />;
  },

  async attention(ctx): Promise<AttentionItem[]> {
    const items: AttentionItem[] = [];
    const latest = await latestScans(ctx);
    for (const { repo, scan } of latest) {
      const a = scan.result.analysis;
      const label = `${repo.owner}/${repo.name}`;
      if (a.signals.appearsToCollectPersonalData.value && !a.maturity.hasPrivacyPolicy) {
        items.push({ id: `product-privacy-${repo.id}`, severity: "review", title: "Your app appears to handle personal data but no privacy policy was found in the repo", detail: `${label}: ${a.signals.appearsToCollectPersonalData.evidence[0] ?? "personal data signals"}. A policy may live on your website instead; check, and review with a professional.`, href: `/app/t/product/${repo.id}` });
      }
      if (a.signals.handlesPayments.value && !a.maturity.hasTerms) {
        items.push({ id: `product-terms-${repo.id}`, severity: "review", title: "Your app appears to take payments but no terms of service were found in the repo", detail: `${label}: ${a.signals.handlesPayments.evidence[0] ?? "payment signals"}.`, href: `/app/t/product/${repo.id}` });
      }
      if (scan.result.meta.private === false && !a.repoLicense) {
        items.push({ id: `product-license-${repo.id}`, severity: "info", title: "A public repository has no license", detail: `${label} is public with no license found, so others have no stated right to use the code.`, href: `/app/t/product/${repo.id}` });
      }
      const age = (deps.now().getTime() - scan.created_at.getTime()) / 86400000;
      if (age > 90) items.push({ id: `product-stale-${repo.id}`, severity: "info", title: "Product scan is out of date", detail: `${label} was last scanned ${Math.floor(age)} days ago. Re-scan to refresh.`, href: `/app/t/product/${repo.id}` });
    }
    return items.slice(0, 10);
  },

  async describe(ctx) {
    const latest = await latestScans(ctx);
    if (latest.length === 0) return "";
    const parts = latest.slice(0, 2).map(({ scan }) => (scan.ai_summary && extractSummaryLine(scan.ai_summary)) || deterministicProfile(scan.result));
    const more = latest.length > 2 ? ` (+${latest.length - 2} more repositories)` : "";
    return `${parts.join(" ")}${more}`.slice(0, 600);
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [r] = await ctx.sql<{ owner: string; name: string }[]>`SELECT owner, name FROM product_repos WHERE id = ${id} AND business_id = ${ctx.businessId}`;
    return r ? { title: `${r.owner}/${r.name}`, href: `/app/t/product/${id}` } : null;
  },

  async search(ctx, query, limit) {
    const like = "%" + query.replace(/[%_\\]/g, "") + "%";
    const rows = await ctx.sql<{ id: string; owner: string; name: string; provider: string }[]>`
      SELECT id, owner, name, provider FROM product_repos WHERE business_id = ${ctx.businessId} AND (name ILIKE ${like} OR owner ILIKE ${like} OR url ILIKE ${like}) ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: `${r.owner}/${r.name}`, snippet: r.provider, href: `/app/t/product/${r.id}` }));
  },

  async facts(ctx) {
    const latest = await latestScans(ctx);
    const [{ n }] = await ctx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM product_repos WHERE business_id = ${ctx.businessId}`;
    const any = (f: (a: ScanResult["analysis"]) => boolean) => latest.some((l) => f(l.scan.result.analysis));
    const stack = [...new Set(latest.flatMap((l) => { const a = l.scan.result.analysis; return [...a.languages, ...a.frameworks, ...a.databases, ...a.services.map((s) => s.name)]; }))];
    const licenses = [...new Set(latest.map((l) => l.scan.result.analysis.repoLicense).filter((x): x is string => Boolean(x)))];
    const last = latest.map((l) => l.scan.created_at.getTime()).sort((a, b) => b - a)[0];
    return {
      linkedRepos: n,
      stack,
      handlesUserAccounts: any((a) => a.signals.handlesUserAccounts.value),
      handlesPayments: any((a) => a.signals.handlesPayments.value),
      appearsToCollectPersonalData: any((a) => a.signals.appearsToCollectPersonalData.value),
      hasPrivacyPolicyInRepo: any((a) => a.maturity.hasPrivacyPolicy),
      license: licenses[0] ?? null,
      lastScanAt: last ? new Date(last).toISOString() : null,
    };
  },
};
