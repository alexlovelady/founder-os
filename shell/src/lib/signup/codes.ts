import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "@founderos/sdk";

export const MAX_USES_LIMIT = 1000;
export const MAX_EXPIRY_DAYS = 365;
export const MAX_ACTIVE_CODES = 200;

const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O/1/I/L: easy to read out loud

/** Canonical form: upper case letters and digits only, so "fos-abcd efgh" and "FOSABCDEFGH" are the same code. */
export const canonicalCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashCode = (code: string): string => createHash("sha256").update(canonicalCode(code)).digest("hex");

/** 20 random characters from a 30-letter alphabet (about 98 bits), shown as FOS-XXXXX-XXXXX-XXXXX-XXXXX. */
export function newCode(): string {
  const bytes = randomBytes(20);
  let s = "";
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i] % ALPHABET.length]; // slight modulo bias is irrelevant at this entropy
  return `FOS-${s.match(/.{5}/g)!.join("-")}`;
}

export type CodeStatus = "active" | "expired" | "revoked" | "used";

export interface CodeSummary {
  id: string;
  label: string;
  maxUses: number;
  useCount: number;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  revokedAt: string | null;
  status: CodeStatus;
}

interface Row { id: string; label: string; max_uses: number; use_count: number; expires_at: Date | null; created_by: string; created_at: Date; revoked_at: Date | null }

export function statusOf(r: Pick<Row, "revoked_at" | "expires_at" | "use_count" | "max_uses">, now = new Date()): CodeStatus {
  if (r.revoked_at) return "revoked";
  if (r.use_count >= r.max_uses) return "used";
  if (r.expires_at && r.expires_at.getTime() <= now.getTime()) return "expired";
  return "active";
}

const summary = (r: Row): CodeSummary => ({
  id: r.id, label: r.label, maxUses: r.max_uses, useCount: r.use_count, expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
  createdBy: r.created_by, createdAt: r.created_at.toISOString(), revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null, status: statusOf(r),
});

export interface CreateCodeArgs { actorId: string; label?: string; maxUses?: number; expiresInDays?: number | null }

/** Creates a code. The raw code is returned ONCE and never stored (only its SHA-256 hash is). */
export async function createCode(sql: Sql, a: CreateCodeArgs): Promise<{ ok: true; code: string; summary: CodeSummary } | { ok: false; message: string }> {
  const maxUses = Math.min(Math.max(Math.floor(a.maxUses ?? 1), 1), MAX_USES_LIMIT);
  const days = a.expiresInDays == null ? null : Math.min(Math.max(Math.floor(a.expiresInDays), 1), MAX_EXPIRY_DAYS);
  const label = (a.label ?? "").trim().slice(0, 100);
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM signup_codes WHERE revoked_at IS NULL AND use_count < max_uses AND (expires_at IS NULL OR expires_at > now())`;
  if (n >= MAX_ACTIVE_CODES) return { ok: false, message: "Too many open codes. Revoke some first." };
  const code = newCode();
  const [row] = await sql<Row[]>`
    INSERT INTO signup_codes (code_hash, label, max_uses, expires_at, created_by)
    VALUES (${hashCode(code)}, ${label}, ${maxUses}, ${days === null ? null : sql`now() + make_interval(days => ${days})`}, ${a.actorId.slice(0, 200)})
    RETURNING id, label, max_uses, use_count, expires_at, created_by, created_at, revoked_at`;
  return { ok: true, code, summary: summary(row) };
}

export async function listCodes(sql: Sql, limit = 100): Promise<CodeSummary[]> {
  const rows = await sql<Row[]>`
    SELECT id, label, max_uses, use_count, expires_at, created_by, created_at, revoked_at FROM signup_codes ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}`;
  return rows.map(summary);
}

/** Revokes (soft: the row stays for audit). Returns null when the id does not exist. */
export async function revokeCode(sql: Sql, id: string): Promise<CodeSummary | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await sql<Row[]>`
    UPDATE signup_codes SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${id}
    RETURNING id, label, max_uses, use_count, expires_at, created_by, created_at, revoked_at`;
  return row ? summary(row) : null;
}

/**
 * Atomically takes one use of a code. One conditional UPDATE does the check and the increment, so two concurrent signups can never
 * both take the last use. Returns the code id, or null when the code is unknown, revoked, expired or used up (callers must not say which).
 */
export async function consumeCode(sql: Sql, raw: string): Promise<string | null> {
  const canon = canonicalCode(raw);
  if (canon.length < 8 || canon.length > 64) return null;
  const [row] = await sql<{ id: string }[]>`
    UPDATE signup_codes SET use_count = use_count + 1
    WHERE code_hash = ${hashCode(raw)} AND revoked_at IS NULL AND use_count < max_uses AND (expires_at IS NULL OR expires_at > now())
    RETURNING id`;
  return row?.id ?? null;
}

/** Gives a use back (the account could not be created). Never goes below zero. */
export async function restoreCode(sql: Sql, id: string): Promise<void> {
  await sql`UPDATE signup_codes SET use_count = use_count - 1 WHERE id = ${id} AND use_count > 0`;
}
