/** A small HTML-to-text helper (no dependencies): readable text, title, description, and links. Not a full HTML parser, by design. */
import { createHash } from "node:crypto";

export interface ExtractedPage {
  title: string;
  description: string;
  text: string;
  links: { url: string; text: string }[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", copy: "(c)", reg: "(r)", trade: "(tm)", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', euro: "EUR ", pound: "GBP ", dollar: "$" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, " ");
const squash = (s: string) => decodeEntities(s).replace(/\s+/g, " ").trim();

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

export function normalizeText(s: string): string {
  const lines = s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean);
  const out: string[] = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
  return out.join("\n");
}

export function extractHtml(html: string, baseUrl: string): ExtractedPage {
  const title = squash(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""));
  let description = "";
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const name = (attr(m[0], "name") ?? attr(m[0], "property") ?? "").toLowerCase();
    if (name === "description" || name === "og:description") {
      description = squash(attr(m[0], "content") ?? "");
      if (description) break;
    }
  }
  // Links come from the whole page (navigation is where "pricing" usually lives), before boilerplate is removed.
  const links: { url: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1], "href");
    if (!href || /^(#|mailto:|tel:|javascript:|data:)/i.test(href.trim())) continue;
    try {
      links.push({ url: new URL(decodeEntities(href.trim()), baseUrl).toString(), text: squash(stripTags(m[2])).slice(0, 80) });
    } catch {
      /* ignore malformed links */
    }
    if (links.length >= 400) break;
  }
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|nav|footer|aside|select|button)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head\s*>/gi, " ");
  body = body.replace(/<\/?(p|div|section|article|main|header|h[1-6]|li|ul|ol|tr|table|br|hr|blockquote|pre|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, "\n").replace(/<\/(td|th)>/gi, " | ");
  const text = normalizeText(decodeEntities(stripTags(body)));
  return { title, description, text, links };
}

export function extractPlain(text: string): ExtractedPage {
  return { title: "", description: "", text: normalizeText(text), links: [] };
}

export function hashText(s: string): string {
  return createHash("sha256").update(s.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex");
}

// ---------- which links are worth reading ----------

const PRICING = /(^|[/-])(pricing|prices?|plans?|plans-and-pricing|packages)([/.-]|$)/i;
const PRODUCT = /(^|[/-])(features?|product|products|solutions?|platform|services|how-it-works|offerings?|why-[\w-]+|use-cases?)([/.-]|$)/i;
const ABOUT = /(^|[/-])(about|about-us|company|our-story|who-we-are)([/.-]|$)/i;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mov|css|js|xml|ico|woff2?|docx?|xlsx?)$/i;
const SKIP_PATH = /(login|log-in|signin|sign-in|signup|sign-up|register|cart|checkout|account|logout|cdn-cgi|wp-admin|privacy|terms|cookie)/i;

const siteKey = (host: string) => host.toLowerCase().replace(/^www\./, "");

export function sameSite(a: string, b: string): boolean {
  try {
    return siteKey(new URL(a).hostname) === siteKey(new URL(b).hostname);
  } catch {
    return false;
  }
}

export function pickLinks(links: { url: string; text: string }[], baseUrl: string, max: number): string[] {
  const seen = new Set<string>([key(baseUrl)]);
  const scored: { url: string; score: number }[] = [];
  for (const l of links) {
    let u: URL;
    try {
      u = new URL(l.url);
    } catch {
      continue;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (!sameSite(l.url, baseUrl) || SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) continue;
    const k = key(l.url);
    if (seen.has(k)) continue;
    const label = l.text.toLowerCase();
    const score = PRICING.test(u.pathname) || /^(pricing|plans?|prices?)$/.test(label) ? 3 : PRODUCT.test(u.pathname) || /^(features?|product|products|solutions?|platform|services)$/.test(label) ? 2 : ABOUT.test(u.pathname) || /^about( us)?$/.test(label) ? 1 : 0;
    if (score === 0) continue;
    seen.add(k);
    scored.push({ url: `https://${u.hostname}${u.pathname}${u.search}`, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.url);
}

function key(url: string): string {
  try {
    const u = new URL(url);
    return `${siteKey(u.hostname)}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url;
  }
}
