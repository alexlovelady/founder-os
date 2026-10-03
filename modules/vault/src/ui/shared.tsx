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

export const NOTE = "Legal review of a document happens in LegalAI. The vault only stores and organizes your files; it does not read or assess their contents.";
