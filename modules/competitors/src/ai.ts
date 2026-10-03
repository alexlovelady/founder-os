export const AI_LABEL = "AI-generated analysis, check against sources.";
export const SUGGESTION_LABEL = "Unverified suggestion, check the website.";

export const ANALYSIS_SYSTEM = [
  "You analyse a competitor of a small business using ONLY the fetched website text provided.",
  "Never use memory about the competitor. If the pages do not say something, leave it out or say it is not stated.",
  "Every claim must cite the source_url of the page it came from, exactly as given. Pricing may only be reported if the page states it, and you must quote the exact words.",
  "Reply with JSON only.",
].join(" ");

export interface PageForPrompt { url: string; fetchedAt: string; title: string; text: string }

export function analysisPrompt(args: { businessText: string; productFacts: unknown; competitor: { name: string; url: string }; pages: PageForPrompt[]; failed: string[] }): string {
  const pages = args.pages.map((p) => `=== PAGE source_url=${p.url} fetched_at=${p.fetchedAt.slice(0, 10)} title=${JSON.stringify(p.title)}\n${p.text.slice(0, 6000)}`).join("\n\n");
  return `${args.businessText}

Facts about our own product (from the Product Scan tool, may be empty): ${JSON.stringify(args.productFacts ?? {})}

COMPETITOR: ${args.competitor.name} (${args.competitor.url})
${args.failed.length ? `Pages that could not be read (do not guess their content): ${args.failed.join("; ")}\n` : ""}
FETCHED WEBSITE TEXT (the only source of truth):
${pages}

Return a single JSON object with this shape and nothing else:
{
 "positioning": [{"claim": "...", "source_url": "...", "quote": "short exact quote from the page"}],
 "target_customer": [ same shape ],
 "offerings": [ same shape ],
 "pricing": [ same shape; ONLY prices or plans stated on a page, with an exact quote; empty array if none ],
 "strengths": [ same shape, grounded in the text ],
 "weaknesses": [ same shape, grounded in the text or clearly missing from it ],
 "comparison_with_us": "2-4 sentences comparing them with our business, labelled as opinion"
}
Use an empty array when the pages say nothing. Never invent a source_url.`;
}

export type ClaimField = "positioning" | "target_customer" | "offerings" | "pricing" | "strengths" | "weaknesses";
export const CLAIM_FIELDS: ClaimField[] = ["positioning", "target_customer", "offerings", "pricing", "strengths", "weaknesses"];

export interface Claim {
  field: ClaimField;
  text: string;
  source_url: string | null;
  fetched_at: string | null;
  quote: string | null;
  quote_verified: boolean | null;
}

export interface ParsedAnalysis {
  parsed: boolean;
  claims: Claim[];
  /** Claims the model made that we refuse to present as sourced (bad source, unverifiable price). */
  rejected: { field: string; text: string; reason: string }[];
  comparison: string | null;
}

const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
const urlKey = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();

/**
 * Turns the model's JSON into claims that are checked against what we really fetched:
 *  - source_url must be one of the fetched pages (fetched_at comes from OUR record, never from the model);
 *  - a quote is "verified" only if it literally appears in that page's text;
 *  - pricing without a verified quote is rejected.
 */
export function parseAnalysis(raw: string, pages: { url: string; fetchedAt: string; text: string }[]): ParsedAnalysis {
  const empty: ParsedAnalysis = { parsed: false, claims: [], rejected: [], comparison: null };
  const body = raw.replace(/```(?:json)?/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return empty;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return empty;
  }
  const byUrl = new Map(pages.map((p) => [urlKey(p.url), p]));
  const claims: Claim[] = [];
  const rejected: ParsedAnalysis["rejected"] = [];
  for (const field of CLAIM_FIELDS) {
    const list = j[field];
    if (!Array.isArray(list)) continue;
    for (const item of list.slice(0, 8)) {
      const o = (typeof item === "string" ? { claim: item } : item) as { claim?: unknown; source_url?: unknown; quote?: unknown };
      const text = typeof o.claim === "string" ? o.claim.trim().slice(0, 500) : "";
      if (!text) continue;
      const page = typeof o.source_url === "string" ? byUrl.get(urlKey(o.source_url)) : undefined;
      const quote = typeof o.quote === "string" && o.quote.trim() ? o.quote.trim().slice(0, 300) : null;
      const verified = quote && page ? norm(page.text).includes(norm(quote)) : quote ? false : null;
      if (field === "pricing" && (!page || verified !== true)) {
        rejected.push({ field, text, reason: !page ? "pricing claim did not cite a page we fetched" : "the quoted price text was not found on the page" });
        continue;
      }
      claims.push({ field, text, source_url: page ? page.url : null, fetched_at: page ? page.fetchedAt : null, quote, quote_verified: verified });
    }
  }
  const comparison = typeof j.comparison_with_us === "string" ? j.comparison_with_us.trim().slice(0, 1500) : null;
  return { parsed: true, claims, rejected, comparison };
}

export const REPORT_SYSTEM = [
  "You compare competitors for a small business using ONLY the sourced claims provided.",
  "Do not add facts from memory. Mark anything that is your own judgment as opinion. Use 'not stated' where the sources are silent.",
].join(" ");

export interface AnalysisForReport { name: string; url: string; analysedAt: string; claims: Claim[]; comparison: string | null }

export function reportPrompt(businessText: string, productFacts: unknown, items: AnalysisForReport[]): string {
  const blocks = items.map((a) => {
    const lines = a.claims.map((c) => `- [${c.field}] ${c.text}${c.source_url ? ` (source: ${c.source_url}, fetched ${c.fetched_at?.slice(0, 10)})` : " (no source)"}`);
    return `### ${a.name} (${a.url}), analysed ${a.analysedAt.slice(0, 10)}\n${lines.join("\n") || "- no sourced claims"}`;
  });
  return `${businessText}

Facts about our own product: ${JSON.stringify(productFacts ?? {})}

SOURCED CLAIMS ABOUT EACH COMPETITOR (the only facts you may use):
${blocks.join("\n\n")}

Write:
First line: "SUMMARY: " plus one sentence (under 300 characters) describing the market as seen in these sources.
## Comparison matrix
A markdown table with one row per competitor and columns: Positioning, Target customer, Offerings, Pricing (only if stated), Strengths, Weaknesses. Use "not stated" for gaps.
## How we compare
Short bullets comparing our business with them, grounded in the claims above.
## Where you could stand out (AI opinion)
3 to 5 suggestions, each labelled as opinion and tied to a gap you can see in the sources.`;
}

export function discoverPrompt(businessText: string, query: string): string {
  return `${businessText}

Task: ${query}
List up to 8 businesses that may compete with or be alternatives to this business, based only on your general knowledge.
Format: one per line, "Name - one short reason". Do not include web addresses unless you are certain. Do not claim any detail is verified.`;
}

export function parseSuggestions(text: string): { name: string; note: string }[] {
  const out: { name: string; note: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/\*\*/g, "").trim();
    if (!line || /^(here|these|note|sure|competitors|alternatives)\b/i.test(line) && !/[-:–—]/.test(line)) continue;
    const m = /^([^-:–—]{2,60}?)\s*[-:–—]\s*(.+)$/.exec(line);
    if (m) out.push({ name: m[1].trim(), note: m[2].trim().slice(0, 200) });
    if (out.length >= 8) break;
  }
  return out;
}

export function extractSummaryLine(text: string): string | null {
  const m = /^\s*SUMMARY:\s*(.+)$/im.exec(text);
  return m ? m[1].trim().slice(0, 300) : null;
}
