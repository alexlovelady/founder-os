/** Fetches a competitor's public pages politely and safely: robots.txt first, a handful of pages, readable text with a content hash. */
import { extractHtml, extractPlain, hashText, pickLinks, sameSite } from "./html";
import { robotsAllows } from "./robots";
import { FetchBlocked, FETCH_LIMITS, ROBOTS_TOKEN, normalizeFetchUrl, safeFetch, type NetDeps } from "./safe-fetch";

export const MAX_PAGES = 6;
export const EXCERPT_CHARS = 12_000;

export interface PageResult {
  url: string;
  status: "ok" | "blocked_robots" | "error";
  error?: string;
  title: string;
  description: string;
  text: string;
  hash: string;
  fetchedAt: Date;
  userAdded: boolean;
}

const friendly = (e: unknown): string => {
  if (e instanceof FetchBlocked) return e.message;
  return "The page could not be fetched";
};

/** robots.txt per origin, cached for one research run. Returns a decision function. */
function robotsGate(deps: NetDeps) {
  const cache = new Map<string, Promise<string | null | "deny-all">>();
  const load = (origin: string): Promise<string | null | "deny-all"> => {
    let p = cache.get(origin);
    if (!p) {
      p = (async () => {
        try {
          const r = await safeFetch(`${origin}/robots.txt`, deps, { maxBytes: 500_000, timeoutMs: 10_000, allowTypes: ["text/plain"] });
          if (r.status >= 200 && r.status < 300) return r.text;
          if (r.status >= 500) return "deny-all"; // the site is in trouble: be conservative and do not crawl
          return null; // 4xx: no robots.txt, everything allowed
        } catch (e) {
          if (e instanceof FetchBlocked && e.code === "type") return null; // an HTML "not found" page served as robots.txt
          if (e instanceof FetchBlocked && ["private", "scheme", "invalid", "port", "dns"].includes(e.code)) throw e;
          return "deny-all"; // could not read it: skip rather than guess
        }
      })();
      cache.set(origin, p);
    }
    return p;
  };
  return async (url: URL): Promise<void> => {
    const robots = await load(url.origin);
    if (robots === null) return;
    if (robots === "deny-all" || !robotsAllows(robots, ROBOTS_TOKEN, `${url.pathname}${url.search}`)) throw new FetchBlocked("robots", "robots.txt asks automated tools not to read this page, so it was skipped");
  };
}

export async function fetchOnePage(rawUrl: string, deps: NetDeps, gate: (u: URL) => Promise<void>, userAdded: boolean, now: () => Date): Promise<{ page: PageResult; links: { url: string; text: string }[] }> {
  const fetchedAt = now();
  try {
    const r = await safeFetch(rawUrl, deps, { beforeRequest: gate });
    if (r.status < 200 || r.status >= 300) {
      return { page: { url: rawUrl, status: "error", error: `The website answered with status ${r.status}`, title: "", description: "", text: "", hash: "", fetchedAt, userAdded }, links: [] };
    }
    const ex = r.contentType === "text/plain" ? extractPlain(r.text) : extractHtml(r.text, r.finalUrl);
    const text = ex.text.slice(0, EXCERPT_CHARS);
    return { page: { url: rawUrl, status: "ok", title: ex.title.slice(0, 200), description: ex.description.slice(0, 400), text, hash: hashText(text), fetchedAt, userAdded }, links: ex.links };
  } catch (e) {
    const robots = e instanceof FetchBlocked && e.code === "robots";
    return { page: { url: rawUrl, status: robots ? "blocked_robots" : "error", error: friendly(e), title: "", description: "", text: "", hash: "", fetchedAt, userAdded }, links: [] };
  }
}

/** Home page, then user-added pages, then pricing/product/about links found on the home page, up to MAX_PAGES. */
export async function researchSite(homeUrl: string, userPages: string[], deps: NetDeps, now: () => Date = () => new Date()): Promise<PageResult[]> {
  const home = normalizeFetchUrl(homeUrl).toString();
  const gate = robotsGate(deps);
  const results: PageResult[] = [];
  const first = await fetchOnePage(home, deps, gate, false, now);
  results.push(first.page);
  const queue: { url: string; userAdded: boolean }[] = [];
  const seen = new Set<string>([key(home)]);
  for (const u of userPages) {
    try {
      const n = normalizeFetchUrl(u).toString();
      if (!seen.has(key(n)) && sameSite(n, home)) { seen.add(key(n)); queue.push({ url: n, userAdded: true }); }
    } catch { /* invalid user page: skipped */ }
  }
  if (first.page.status === "ok") {
    for (const u of pickLinks(first.links, home, MAX_PAGES)) if (!seen.has(key(u))) { seen.add(key(u)); queue.push({ url: u, userAdded: false }); }
  }
  for (const q of queue.slice(0, MAX_PAGES - 1)) results.push((await fetchOnePage(q.url, deps, gate, q.userAdded, now)).page);
  return results;
}

function key(url: string): string {
  const u = new URL(url);
  return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}${u.search}`;
}

export { FETCH_LIMITS };
