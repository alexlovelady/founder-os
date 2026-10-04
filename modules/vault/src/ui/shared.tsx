"use client";

export interface DocDto {
  id: string;
  name: string;
  originalFilename: string;
  category: string;
  docType: string;
  tags: string[];
  status: "active" | "draft" | "review" | "archived";
  expirationDate: string | null;
  daysLeft: number | null;
  version: number;
  sha256: string;
  size: number;
  contentType: string;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
  textStatus: "pending" | "ready" | "failed" | "unsupported" | null;
  /** Highlighted passage (HTML-escaped, matches in <mark>) when a search matched the file's text. */
  snippet?: string;
}

export interface ExtractionDto {
  status: "none" | "pending" | "ready" | "failed" | "unsupported";
  error: string | null;
  pageCount: number | null;
  chars: number;
  extractedAt: string | null;
  needsOcr: boolean;
}
export interface SuggestionDto {
  category: string;
  docType: string;
  confidence: "high" | "medium";
  evidence: string[];
}
export interface SummaryDto {
  text: string;
  createdAt: string | null;
  truncated: boolean;
  version: number | null;
  label: string;
}
export interface LegalLinkDto {
  legalDocumentId: string;
  legalReviewId: string | null;
  legalWorkspaceId?: string | null;
  perspective: string;
  version: number;
  createdAt: string;
}
export interface DetailDto {
  document: DocDto;
  versions: VersionDto[];
  extraction: ExtractionDto;
  suggestion: SuggestionDto | null;
  summary: SummaryDto | null;
  summaryPending: boolean;
  legalLink: LegalLinkDto | null;
}

export interface VersionDto {
  version: number;
  originalFilename: string;
  contentType: string;
  size: number;
  sha256: string;
  uploadedBy: string;
  createdAt: string;
  isCurrent: boolean;
}

export const BASE = "/api/tools/vault";
export const ACCEPT = ".pdf,.docx,.doc,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.webp";

export async function readError(r: Response): Promise<string> {
  const d = await r.json().catch(() => ({}));
  return d.error ?? "Something went wrong";
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function ExpiryBadge({ date, daysLeft }: { date: string | null; daysLeft: number | null }) {
  if (!date || daysLeft == null) return <span className="text-xs text-slate-500">No expiry</span>;
  const tone =
    daysLeft < 0 ? "border-red-500/40 bg-red-500/10 text-red-300" : daysLeft <= 30 ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : daysLeft <= 60 ? "border-sky-500/40 bg-sky-500/10 text-sky-300" : "border-slate-600 bg-slate-800 text-slate-300";
  const text = daysLeft < 0 ? `Expired ${date}` : daysLeft === 0 ? "Expires today" : daysLeft <= 60 ? `Expires in ${daysLeft}d` : `Expires ${date}`;
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${tone}`}>{text}</span>;
}

export const NOTE = "Legal review of a document happens in LegalAI. The vault stores and organizes your files and reads their text so you can search them; it does not assess what they say.";

const UNESCAPE: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/** Render a server snippet (HTML-escaped text with <mark> around matches) as React nodes without ever using innerHTML. */
export function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<mark>|<\/mark>)/);
  return (
    <span>
      {parts.map((part, i) => {
        if (part === "<mark>" || part === "</mark>") return null;
        const text = part.replace(/&(amp|lt|gt|quot|#39);/g, (m) => UNESCAPE[m] ?? m);
        // Text directly after a <mark> tag is the highlighted match.
        return parts[i - 1] === "<mark>" ? <mark key={i} className="rounded bg-amber-400/30 px-0.5 text-amber-100">{text}</mark> : <span key={i}>{text}</span>;
      })}
    </span>
  );
}

/** A link to the billing page, shown after a plan-limit message (HTTP 402) from the server. */
export function PlanLink({ msg }: { msg?: string }) {
  return msg && /plan/i.test(msg) ? <a className="ml-2 underline" href="/app/billing">See plans and usage</a> : null;
}
