/** Storage and search of extracted document text (vault_text). Every query is scoped by business_id. */
import type { Sql, ToolContext } from "@founderos/sdk";
import { extractText, SCANNED_MESSAGE, type ExtractResult } from "./extract";

export type TextStatus = "pending" | "ready" | "failed" | "unsupported";
export const SUMMARY_INPUT_CHARS = 6000;
export const SUMMARY_LABEL = "AI summary, check against the document";

const START = "\u0001";
const STOP = "\u0002";

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Turn a ts_headline result (matches wrapped in private sentinel characters) into HTML-safe text with <mark> around each match. */
export function safeSnippet(raw: string): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return escapeHtml(flat).split(START).join("<mark>").split(STOP).join("</mark>");
}

/** The reverse of safeSnippet, for tools that want plain text: no markup, entities decoded. */
export const plainSnippet = (html: string) => html.replace(/<\/?mark>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

export const HEADLINE_OPTS = `StartSel=${START}, StopSel=${STOP}, MaxWords=28, MinWords=10, MaxFragments=1, ShortWord=2`;

export async function markPending(sql: Sql, businessId: string, documentId: string, version: number): Promise<void> {
  await sql`
    INSERT INTO vault_text (document_id, version, business_id, text, status) VALUES (${documentId}, ${version}, ${businessId}, '', 'pending')
    ON CONFLICT (document_id, version) DO UPDATE SET text = '', page_count = NULL, status = 'pending', error = NULL, extracted_at = NULL`;
}

async function save(sql: Sql, businessId: string, documentId: string, version: number, r: ExtractResult): Promise<void> {
  await sql`
    UPDATE vault_text SET text = ${r.text}, page_count = ${r.pageCount}, status = ${r.status}, error = ${r.error}, extracted_at = now()
    WHERE document_id = ${documentId} AND version = ${version} AND business_id = ${businessId}`;
}

/**
 * Extract the text of one stored version and record the outcome. Best effort: never throws, so it can never fail an upload.
 * Older versions' text is removed so search only covers the current file.
 */
export async function extractAndStore(sql: Sql, businessId: string, documentId: string, version: number, ext: string, bytes: Uint8Array): Promise<TextStatus> {
  let r: ExtractResult;
  try {
    r = await extractText(ext, bytes);
  } catch {
    r = { status: "failed", text: "", pageCount: null, error: "The text of this file could not be read." };
  }
  try {
    await save(sql, businessId, documentId, version, r);
  } catch {
    // e.g. the text could not be indexed; keep the row, record the failure without the text
    r = { status: "failed", text: "", pageCount: null, error: "The text of this file could not be indexed." };
    try {
      await save(sql, businessId, documentId, version, r);
    } catch {
      return "failed";
    }
  }
  try {
    await sql`DELETE FROM vault_text WHERE document_id = ${documentId} AND business_id = ${businessId} AND version < ${version}`;
  } catch {
    /* harmless */
  }
  return r.status;
}

export interface ExtractionInfo {
  status: TextStatus | "none";
  error: string | null;
  pageCount: number | null;
  chars: number;
  extractedAt: string | null;
  /** True when the reason is a scan or image: the UI points the user at LegalAI OCR. */
  needsOcr: boolean;
}

export async function loadExtraction(ctx: ToolContext, documentId: string, version: number): Promise<ExtractionInfo> {
  const [t] = await ctx.sql<{ status: TextStatus; error: string | null; page_count: number | null; chars: number; extracted_at: Date | null }[]>`
    SELECT status, error, page_count, length(text)::int AS chars, extracted_at FROM vault_text
    WHERE document_id = ${documentId} AND version = ${version} AND business_id = ${ctx.businessId}`;
  if (!t) return { status: "none", error: null, pageCount: null, chars: 0, extractedAt: null, needsOcr: false };
  return { status: t.status, error: t.error, pageCount: t.page_count, chars: t.chars, extractedAt: t.extracted_at?.toISOString() ?? null, needsOcr: t.error === SCANNED_MESSAGE };
}

/** Highlighted snippets for the given documents (current versions only), keyed by document id, plus a relevance rank. */
export async function textMatches(ctx: ToolContext, text: string, ids?: string[]): Promise<Map<string, { snippet: string; rank: number }>> {
  const sql = ctx.sql;
  const out = new Map<string, { snippet: string; rank: number }>();
  if (!text.trim()) return out;
  const idFilter = ids ? sql`AND d.id = ANY(${ids}::uuid[])` : sql``;
  const rows = await sql<{ id: string; rank: number; snippet: string }[]>`
    SELECT d.id, ts_rank(t.tsv, q.q)::float8 AS rank, ts_headline('english', left(t.text, 300000), q.q, ${HEADLINE_OPTS}::text) AS snippet
    FROM vault_documents d
    JOIN vault_text t ON t.document_id = d.id AND t.version = d.version AND t.business_id = d.business_id AND t.status = 'ready'
    CROSS JOIN (SELECT plainto_tsquery('english', ${text}) AS q) q
    WHERE d.business_id = ${ctx.businessId} AND t.tsv @@ q.q ${idFilter}
    ORDER BY rank DESC LIMIT 100`;
  for (const r of rows) out.set(r.id, { snippet: safeSnippet(r.snippet), rank: r.rank });
  return out;
}
