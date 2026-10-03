/** Pure CRM logic: no database, no React. Usable on the server and in the browser, and easy to test with controllable dates. */

export const CONTACT_TYPES = ["lead", "customer", "vendor", "partner"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const CONTACT_STATUSES = ["active", "inactive"] as const;

export const STAGES = ["lead", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"] as const;
export type Stage = (typeof STAGES)[number];
export const OPEN_STAGES: readonly Stage[] = ["lead", "contacted", "qualified", "proposal_sent", "negotiation"];
export const CLOSED_STAGES: readonly Stage[] = ["won", "lost"];
export const isOpenStage = (s: string): boolean => (OPEN_STAGES as readonly string[]).includes(s);

export const STAGE_LABELS: Record<Stage, string> = {
  lead: "Lead",
  contacted: "Contacted",
  qualified: "Qualified",
  proposal_sent: "Proposal sent",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

export const DEFAULT_STALE_DAYS = 14;
const DAY_MS = 86_400_000;

export const normalizeEmail = (e: string | null | undefined): string => (e ?? "").trim().toLowerCase();
export const EMAIL_RE = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]{2,}$/;

/** True when an open item has had no activity for at least `days` days. Closed items are never stale. */
export function isStale(lastActivity: Date | string, now: Date, days = DEFAULT_STALE_DAYS, open = true): boolean {
  if (!open) return false;
  const t = new Date(lastActivity).getTime();
  return now.getTime() - t >= days * DAY_MS;
}

export function daysBetween(from: Date | string, to: Date): number {
  return Math.floor((to.getTime() - new Date(from).getTime()) / DAY_MS);
}

/** Today as YYYY-MM-DD (UTC). */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

export const formatUsd = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/* ---------------------------------------------------------------- CSV */

/** Parses CSV text (RFC 4180 style: quotes, doubled quotes, CRLF, embedded newlines, optional BOM) into rows of cells. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      rows.push(row); row = [];
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

/** Neutralise spreadsheet formula injection while keeping normal phone numbers readable. */
function safeCell(v: string): string {
  let s = v;
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map((c) => safeCell(c ?? "")).join(",")).join("\r\n") + "\r\n";
}

export const CSV_COLUMNS = ["name", "company", "email", "phone", "type", "tags"] as const;
export const MAX_IMPORT_ROWS = 2000;

export interface ImportRow {
  line: number;
  name: string;
  company: string;
  email: string;
  phone: string;
  type: ContactType;
  tags: string[];
}
export interface ImportError { line: number; error: string }

export function splitTags(raw: string): string[] {
  const out: string[] = [];
  for (const t of raw.split(/[;|,]/)) {
    const v = t.trim().slice(0, 40);
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out.slice(0, 20);
}

/** Validates a contacts CSV. `line` is the 1-based line of the record in the file (the header is line 1). */
export function parseContactsCsv(text: string): { rows: ImportRow[]; errors: ImportError[]; fatal?: string } {
  const all = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (all.length === 0) return { rows: [], errors: [], fatal: "The file is empty" };
  const header = all[0].map((h) => h.trim().toLowerCase());
  if (!header.includes("name")) return { rows: [], errors: [], fatal: 'The first row must be a header that includes a "name" column' };
  const idx = (k: string) => header.indexOf(k);
  const body = all.slice(1);
  if (body.length > MAX_IMPORT_ROWS) return { rows: [], errors: [], fatal: `Too many rows (max ${MAX_IMPORT_ROWS} per import)` };
  const rows: ImportRow[] = [];
  const errors: ImportError[] = [];
  const seen = new Map<string, number>();
  body.forEach((cells, i) => {
    const line = i + 2;
    const get = (k: string) => (idx(k) >= 0 ? (cells[idx(k)] ?? "").trim() : "");
    const name = get("name");
    const email = get("email");
    const typeRaw = get("type").toLowerCase();
    const problems: string[] = [];
    if (!name) problems.push("name is required");
    else if (name.length > 200) problems.push("name is longer than 200 characters");
    if (get("company").length > 200) problems.push("company is longer than 200 characters");
    if (get("phone").length > 40) problems.push("phone is longer than 40 characters");
    if (email && (email.length > 254 || !EMAIL_RE.test(email))) problems.push("email is not valid");
    if (typeRaw && !(CONTACT_TYPES as readonly string[]).includes(typeRaw)) problems.push(`type must be one of ${CONTACT_TYPES.join(", ")}`);
    if (email && problems.length === 0) {
      const key = normalizeEmail(email);
      const first = seen.get(key);
      if (first) problems.push(`duplicate email, already on line ${first} of this file`);
      else seen.set(key, line);
    }
    if (problems.length) { errors.push({ line, error: problems.join("; ") }); return; }
    rows.push({ line, name, company: get("company"), email, phone: get("phone"), type: (typeRaw || "lead") as ContactType, tags: splitTags(get("tags")) });
  });
  return { rows, errors };
}

/* ------------------------------------------------------- stage analytics */

export interface HistoryEvent { opportunityId: string; fromStage: string | null; toStage: string; changedAt: Date | string }
export interface StageStat { stage: Stage; reached: number; avgDaysInStage: number | null }

/**
 * From stage history, work out how long opportunities spend in each stage and how many reached it.
 * The time in a stage runs from entering it to the next change; for a stage an opportunity is still in, to `now`.
 * Won and lost are end states, so they have no time in stage.
 */
export function computeStageStats(history: HistoryEvent[], now: Date): { stages: StageStat[]; won: number; lost: number; winRatePct: number | null } {
  const byOpp = new Map<string, HistoryEvent[]>();
  for (const h of history) (byOpp.get(h.opportunityId) ?? byOpp.set(h.opportunityId, []).get(h.opportunityId)!).push(h);
  const reached = new Map<Stage, Set<string>>();
  const durations = new Map<Stage, number[]>();
  let won = 0;
  let lost = 0;
  for (const [oppId, events] of byOpp) {
    const sorted = [...events].sort((a, b) => new Date(a.changedAt).getTime() - new Date(b.changedAt).getTime());
    sorted.forEach((e, i) => {
      const stage = e.toStage as Stage;
      (reached.get(stage) ?? reached.set(stage, new Set()).get(stage)!).add(oppId);
      if (!isOpenStage(stage)) return;
      const end = sorted[i + 1] ? new Date(sorted[i + 1].changedAt) : now;
      const days = Math.max(0, (end.getTime() - new Date(e.changedAt).getTime()) / DAY_MS);
      (durations.get(stage) ?? durations.set(stage, []).get(stage)!).push(days);
    });
    const last = sorted[sorted.length - 1]?.toStage;
    if (last === "won") won++;
    if (last === "lost") lost++;
  }
  const stages = STAGES.map((stage) => {
    const d = durations.get(stage) ?? [];
    return { stage, reached: reached.get(stage)?.size ?? 0, avgDaysInStage: d.length ? Math.round((d.reduce((a, b) => a + b, 0) / d.length) * 10) / 10 : null };
  });
  return { stages, won, lost, winRatePct: won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null };
}
