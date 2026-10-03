/**
 * Repository scanner. No git binary: everything goes through the GitHub and GitLab REST APIs on FIXED hosts
 * (api.github.com and gitlab.com/api/v4). The user's URL only ever supplies owner/name, which are validated and URL-encoded;
 * it never chooses a host. Redirects are followed only when they stay on the same fixed host.
 *
 * Reads a small, capped set of files, keeps only short excerpts, and never stores source code.
 */
import { analyze, IGNORED_PATH, MANIFEST_NAMES, parseEnvNames, PRIVACY_FILE, TERMS_FILE, type Analysis, type ScanFile } from "./analyze";
import type { Provider, RepoRef } from "./repo-url";

export const LIMITS = {
  totalBytes: 400_000,
  fileBytes: 60_000,
  maxFiles: 24,
  maxTreeEntries: 3000,
  gitlabTreePages: 10,
  topLevelStored: 80,
  excerptReadme: 4000,
  excerptOther: 1200,
};

export class ScanError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

export interface ScanDeps {
  fetch: typeof fetch;
  now: () => Date;
}

export interface TreeEntry { path: string; type: "blob" | "tree"; sha?: string; size?: number }

export interface FileExcerpt { path: string; bytes: number; truncated: boolean; excerpt: string; kind: string }

export interface ScanResult {
  version: 1;
  scannedAt: string;
  provider: Provider;
  owner: string;
  name: string;
  url: string;
  meta: {
    description: string | null;
    defaultBranch: string | null;
    license: string | null;
    stars: number | null;
    forks: number | null;
    openIssues: number | null;
    archived: boolean;
    private: boolean | null;
    createdAt: string | null;
    pushedAt: string | null;
    topics: string[];
    homepage: string | null;
  };
  languages: { name: string; pct: number }[];
  activity: { commitsLast90d: number | null; commitsCapped: boolean; lastCommitAt: string | null; contributors: number | null; contributorsCapped: boolean };
  tree: { totalEntries: number; truncated: boolean; topLevel: { path: string; type: "blob" | "tree" }[] };
  files: FileExcerpt[];
  skipped: { path: string; reason: string }[];
  bytesRead: number;
  analysis: Analysis;
}

interface Adapter {
  meta(): Promise<ScanResult["meta"]>;
  languages(): Promise<{ name: string; pct: number }[]>;
  activity(since: Date): Promise<ScanResult["activity"]>;
  tree(branch: string): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  readFile(entry: TreeEntry, branch: string, maxBytes: number): Promise<string>;
}

const UA = "FounderOS-ProductScan/1.0";
const ALLOWED_API_HOSTS = new Set(["api.github.com", "gitlab.com"]);

/** GET against a fixed API host. Token goes only to that host; redirects stay on the host. */
async function apiGet(deps: ScanDeps, url: string, headers: Record<string, string>): Promise<Response> {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(target);
    if (u.protocol !== "https:" || !ALLOWED_API_HOSTS.has(u.hostname)) throw new ScanError("Refused to contact an unexpected host");
    let res: Response;
    try {
      res = await deps.fetch(target, { headers: { "user-agent": UA, ...headers }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new ScanError("Could not reach the code host. Try again later.");
    }
    if ([301, 302, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new ScanError("Unexpected redirect from the code host");
      target = new URL(loc, target).toString();
      continue;
    }
    return res;
  }
  throw new ScanError("Too many redirects from the code host");
}

function httpError(res: Response, hasToken: boolean): ScanError {
  if (res.status === 404 || res.status === 401) {
    return new ScanError(hasToken ? "Repository not found, or the access token cannot read it." : "Repository not found. If it is private, add a read-only access token.", 404);
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get("x-ratelimit-remaining") ?? res.headers.get("ratelimit-remaining");
    if (remaining === "0" || res.status === 429) return new ScanError(hasToken ? "The code host rate limit was reached. Try again later." : "The code host rate limit for unauthenticated requests was reached. Try again later or add a token.", 429);
    return new ScanError(hasToken ? "The access token is not allowed to read this repository." : "Access denied. If the repository is private, add a read-only access token.", 403);
  }
  return new ScanError(`The code host answered with an error (${res.status}).`);
}

async function getJson<T>(deps: ScanDeps, url: string, headers: Record<string, string>, hasToken: boolean, optional: false): Promise<T>;
async function getJson<T>(deps: ScanDeps, url: string, headers: Record<string, string>, hasToken: boolean, optional: true): Promise<T | null>;
async function getJson<T>(deps: ScanDeps, url: string, headers: Record<string, string>, hasToken: boolean, optional: boolean): Promise<T | null> {
  try {
    const res = await apiGet(deps, url, headers);
    if (res.status === 204) return null;
    if (!res.ok) throw httpError(res, hasToken);
    return (await res.json()) as T;
  } catch (e) {
    if (optional) return null;
    throw e;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// ---------- GitHub ----------

function githubAdapter(ref: RepoRef, token: string | undefined, deps: ScanDeps): Adapter {
  const h: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
  if (token) h.authorization = `Bearer ${token}`;
  const root = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}`;
  const hasToken = Boolean(token);
  return {
    async meta() {
      const j = await getJson<Record<string, unknown>>(deps, root, h, hasToken, false);
      const lic = j.license as { spdx_id?: string; name?: string } | null;
      return {
        description: str(j.description),
        defaultBranch: str(j.default_branch),
        license: lic ? (lic.spdx_id && lic.spdx_id !== "NOASSERTION" ? lic.spdx_id : (lic.name ?? null)) : null,
        stars: num(j.stargazers_count),
        forks: num(j.forks_count),
        openIssues: num(j.open_issues_count),
        archived: j.archived === true,
        private: typeof j.private === "boolean" ? j.private : null,
        createdAt: str(j.created_at),
        pushedAt: str(j.pushed_at),
        topics: Array.isArray(j.topics) ? j.topics.filter((t): t is string => typeof t === "string").slice(0, 20) : [],
        homepage: str(j.homepage),
      };
    },
    async languages() {
      const j = await getJson<Record<string, number>>(deps, `${root}/languages`, h, hasToken, true);
      return toPercent(j ?? {});
    },
    async activity(since) {
      const commits = await getJson<{ commit?: { committer?: { date?: string } } }[]>(deps, `${root}/commits?per_page=100&since=${encodeURIComponent(since.toISOString())}`, h, hasToken, true);
      let last: string | null = commits?.[0]?.commit?.committer?.date ?? null;
      if (!last) {
        const one = await getJson<{ commit?: { committer?: { date?: string } } }[]>(deps, `${root}/commits?per_page=1`, h, hasToken, true);
        last = one?.[0]?.commit?.committer?.date ?? null;
      }
      const contributors = await getJson<unknown[]>(deps, `${root}/contributors?per_page=100`, h, hasToken, true);
      return {
        commitsLast90d: commits ? commits.length : null,
        commitsCapped: (commits?.length ?? 0) >= 100,
        lastCommitAt: last,
        contributors: contributors ? contributors.length : null,
        contributorsCapped: (contributors?.length ?? 0) >= 100,
      };
    },
    async tree(branch) {
      const res = await apiGet(deps, `${root}/git/trees/${encodeURIComponent(branch)}?recursive=1`, h);
      if (res.status === 409) return { entries: [], truncated: false }; // empty repository
      if (!res.ok) throw httpError(res, hasToken);
      const j = (await res.json()) as { tree?: { path: string; type: string; sha?: string; size?: number }[]; truncated?: boolean };
      const entries = (j.tree ?? []).filter((t) => t.type === "blob" || t.type === "tree").map((t) => ({ path: t.path, type: t.type as "blob" | "tree", sha: t.sha, size: t.size }));
      return { entries, truncated: j.truncated === true };
    },
    async readFile(entry, _branch, maxBytes) {
      if (!entry.sha || !/^[0-9a-f]{40,64}$/.test(entry.sha)) throw new ScanError("Bad file reference");
      const j = await getJson<{ content?: string; encoding?: string }>(deps, `${root}/git/blobs/${entry.sha}`, h, hasToken, false);
      if (j.encoding !== "base64" || typeof j.content !== "string") throw new ScanError("Unexpected file encoding");
      return Buffer.from(j.content, "base64").subarray(0, maxBytes).toString("utf8");
    },
  };
}

// ---------- GitLab ----------

function gitlabAdapter(ref: RepoRef, token: string | undefined, deps: ScanDeps): Adapter {
  const h: Record<string, string> = {};
  if (token) h["private-token"] = token;
  const hasToken = Boolean(token);
  const root = `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${ref.owner}/${ref.name}`)}`;
  return {
    async meta() {
      const j = await getJson<Record<string, unknown>>(deps, `${root}?license=true`, h, hasToken, false);
      const lic = j.license as { key?: string; nickname?: string; name?: string } | null | undefined;
      return {
        description: str(j.description),
        defaultBranch: str(j.default_branch),
        license: lic ? (lic.nickname ?? lic.name ?? lic.key ?? null) : null,
        stars: num(j.star_count),
        forks: num(j.forks_count),
        openIssues: num(j.open_issues_count),
        archived: j.archived === true,
        private: typeof j.visibility === "string" ? j.visibility !== "public" : null,
        createdAt: str(j.created_at),
        pushedAt: str(j.last_activity_at),
        topics: Array.isArray(j.topics) ? j.topics.filter((t): t is string => typeof t === "string").slice(0, 20) : [],
        homepage: null,
      };
    },
    async languages() {
      const j = await getJson<Record<string, number>>(deps, `${root}/languages`, h, hasToken, true);
      return Object.entries(j ?? {}).map(([name, pct]) => ({ name, pct: Math.round(pct * 10) / 10 })).sort((a, b) => b.pct - a.pct);
    },
    async activity(since) {
      const commits = await getJson<{ committed_date?: string }[]>(deps, `${root}/repository/commits?per_page=100&since=${encodeURIComponent(since.toISOString())}`, h, hasToken, true);
      let last: string | null = commits?.[0]?.committed_date ?? null;
      if (!last) {
        const one = await getJson<{ committed_date?: string }[]>(deps, `${root}/repository/commits?per_page=1`, h, hasToken, true);
        last = one?.[0]?.committed_date ?? null;
      }
      const contributors = await getJson<unknown[]>(deps, `${root}/repository/contributors?per_page=100`, h, hasToken, true);
      return {
        commitsLast90d: commits ? commits.length : null,
        commitsCapped: (commits?.length ?? 0) >= 100,
        lastCommitAt: last,
        contributors: contributors ? contributors.length : null,
        contributorsCapped: (contributors?.length ?? 0) >= 100,
      };
    },
    async tree(branch) {
      const entries: TreeEntry[] = [];
      let truncated = false;
      for (let page = 1; page <= LIMITS.gitlabTreePages; page++) {
        const res = await apiGet(deps, `${root}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}`, h);
        if (res.status === 404 && page === 1) {
          // 404 on the tree of an existing project means an empty repository (or a missing branch); meta already proved access.
          return { entries: [], truncated: false };
        }
        if (!res.ok) throw httpError(res, hasToken);
        const j = (await res.json()) as { id?: string; path: string; type: string }[];
        for (const t of j) if (t.type === "blob" || t.type === "tree") entries.push({ path: t.path, type: t.type, sha: t.id });
        if (j.length < 100) return { entries, truncated };
        if (page === LIMITS.gitlabTreePages) truncated = true;
      }
      return { entries, truncated };
    },
    async readFile(entry, branch, maxBytes) {
      const res = await apiGet(deps, `${root}/repository/files/${encodeURIComponent(entry.path)}/raw?ref=${encodeURIComponent(branch)}`, h);
      if (!res.ok) throw httpError(res, hasToken);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > 1_000_000) throw new ScanError("File too large");
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.subarray(0, maxBytes).toString("utf8");
    },
  };
}

function toPercent(bytes: Record<string, number>): { name: string; pct: number }[] {
  const total = Object.values(bytes).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (!total) return [];
  return Object.entries(bytes).map(([name, b]) => ({ name, pct: Math.round((b / total) * 1000) / 10 })).sort((a, b) => b.pct - a.pct);
}

// ---------- choosing files ----------

const depth = (p: string) => p.split("/").length - 1;
const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

interface Candidate { entry: TreeEntry; kind: string; priority: number }

export function chooseFiles(entries: TreeEntry[]): Candidate[] {
  const out: Candidate[] = [];
  const usable = entries.filter((e) => e.type === "blob" && !IGNORED_PATH.test(e.path));
  const counts: Record<string, number> = {};
  const take = (kind: string, max: number) => ((counts[kind] = (counts[kind] ?? 0) + 1) <= max);
  for (const e of usable) {
    const b = baseName(e.path).toLowerCase();
    const d = depth(e.path);
    if (d === 0 && /^readme(\.(md|markdown|rst|txt))?$/.test(b)) out.push({ entry: e, kind: "readme", priority: 0 });
    else if (MANIFEST_NAMES.includes(b) && d <= 3) out.push({ entry: e, kind: "manifest", priority: 10 + d });
    else if (d <= 2 && /^(dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(b)) out.push({ entry: e, kind: "container", priority: 20 + d });
    else if (d <= 2 && (/^\.env\.(example|sample|template|dist)$/.test(b) || b === "env.example" || b === ".env.default")) out.push({ entry: e, kind: "env", priority: 30 + d });
    else if (d === 0 && /^(license|licence|copying|unlicense)(\.(md|txt))?$/.test(b)) out.push({ entry: e, kind: "license", priority: 40 });
    else if (/^docs?\/(readme|index|introduction|overview)\.(md|mdx|rst|txt)$/i.test(e.path)) out.push({ entry: e, kind: "docs", priority: 50 });
    else if (d <= 4 && (PRIVACY_FILE.test(e.path) || TERMS_FILE.test(e.path)) && /\.(md|mdx|txt|html?|rst)$/i.test(e.path)) out.push({ entry: e, kind: "legal", priority: 60 + d });
  }
  const max: Record<string, number> = { readme: 1, manifest: 12, container: 3, env: 3, license: 1, docs: 1, legal: 3 };
  return out.sort((a, b) => a.priority - b.priority || a.entry.path.localeCompare(b.entry.path)).filter((c) => take(c.kind, max[c.kind])).slice(0, LIMITS.maxFiles);
}

// ---------- scan ----------

export async function scanRepository(ref: RepoRef, token: string | undefined, deps: ScanDeps): Promise<ScanResult> {
  const a = ref.provider === "github" ? githubAdapter(ref, token, deps) : gitlabAdapter(ref, token, deps);
  const now = deps.now();
  const meta = await a.meta();
  const branch = meta.defaultBranch;
  const [languages, activity] = await Promise.all([a.languages(), a.activity(new Date(now.getTime() - 90 * 86400000))]);
  const { entries, truncated } = branch ? await a.tree(branch) : { entries: [] as TreeEntry[], truncated: false };
  const capped = entries.slice(0, LIMITS.maxTreeEntries);

  const files: FileExcerpt[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const forAnalysis: ScanFile[] = [];
  let bytesRead = 0;
  for (const c of chooseFiles(capped)) {
    if (bytesRead >= LIMITS.totalBytes) {
      skipped.push({ path: c.entry.path, reason: "total read limit reached" });
      continue;
    }
    if ((c.entry.size ?? 0) > 1_000_000) {
      skipped.push({ path: c.entry.path, reason: "file too large" });
      continue;
    }
    const room = Math.min(LIMITS.fileBytes, LIMITS.totalBytes - bytesRead);
    try {
      const text = await a.readFile(c.entry, branch!, room);
      const size = Math.max(Buffer.byteLength(text), 0);
      bytesRead += size;
      const truncatedFile = (c.entry.size ?? 0) > room;
      forAnalysis.push({ path: c.entry.path, text });
      // Keep evidence, not source: short excerpts only; .env files keep variable NAMES only, never values.
      const excerpt = c.kind === "env" ? parseEnvNames(text).join("\n") : text.slice(0, c.kind === "readme" ? LIMITS.excerptReadme : LIMITS.excerptOther);
      files.push({ path: c.entry.path, bytes: size, truncated: truncatedFile, excerpt, kind: c.kind });
    } catch (e) {
      if (e instanceof ScanError && (e.status === 429 || e.status === 403) && e.message.includes("rate limit")) throw e;
      skipped.push({ path: c.entry.path, reason: "could not be read" });
    }
  }

  const topLevel = capped.filter((e) => depth(e.path) === 0).slice(0, LIMITS.topLevelStored).map((e) => ({ path: e.path, type: e.type }));
  const analysis = analyze({ paths: capped.map((e) => e.path), files: forAnalysis, repoLicense: meta.license, languages, lastCommitAt: activity.lastCommitAt, now });
  return {
    version: 1,
    scannedAt: now.toISOString(),
    provider: ref.provider,
    owner: ref.owner,
    name: ref.name,
    url: ref.url,
    meta,
    languages: languages.slice(0, 12),
    activity,
    tree: { totalEntries: entries.length, truncated: truncated || entries.length > capped.length, topLevel },
    files,
    skipped,
    bytesRead,
    analysis,
  };
}
