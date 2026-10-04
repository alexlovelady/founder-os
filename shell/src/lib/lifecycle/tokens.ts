import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "@founderos/sdk";

export const SELF_RESET_MINUTES = 30;
export const ADMIN_RESET_HOURS = 24;
export const VERIFY_HOURS = 24;
export const UNVERIFIED_PURGE_DAYS = 7;

/** 256 bits from the OS random source, URL safe. Shown only in the emailed (or admin-shown) link. */
export const newToken = (): string => randomBytes(32).toString("base64url");

/** Tokens are high-entropy random values, so a plain SHA-256 is enough; only this hash is ever stored. */
export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Cheap shape check so garbage never reaches the database (a real token is 43 base64url characters). */
export const plausibleToken = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(t);

export type TokenTable = "password_reset_tokens" | "email_verifications";

/**
 * Atomically use a token: one conditional UPDATE, so of any number of concurrent requests exactly one gets the row.
 * Returns the owner (and who created it) or null when the token is unknown, expired or already used.
 */
export async function claimToken(sql: Sql, table: TokenTable, token: string): Promise<{ id: string; userId: string; createdBy?: string } | null> {
  if (!plausibleToken(token)) return null;
  const h = hashToken(token);
  const rows =
    table === "password_reset_tokens"
      ? await sql<{ id: string; user_id: string; created_by: string }[]>`
          UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = ${h} AND used_at IS NULL AND expires_at > now() RETURNING id, user_id, created_by`
      : await sql<{ id: string; user_id: string; created_by?: string }[]>`
          UPDATE email_verifications SET used_at = now() WHERE token_hash = ${h} AND used_at IS NULL AND expires_at > now() RETURNING id, user_id`;
  const r = rows[0];
  return r ? { id: r.id, userId: r.user_id, createdBy: r.created_by } : null;
}

/** Give a claimed token back (the follow-up call to LegalAI failed, so the person should be able to retry with the same link). */
export async function releaseToken(sql: Sql, table: TokenTable, id: string): Promise<void> {
  try {
    if (table === "password_reset_tokens") await sql`UPDATE password_reset_tokens SET used_at = NULL WHERE id = ${id}`;
    else await sql`UPDATE email_verifications SET used_at = NULL WHERE id = ${id}`;
  } catch {
    /* the person can request a new link */
  }
}

/** Read-only check for the page that shows the form (does not consume anything). */
export async function tokenIsLive(sql: Sql, table: TokenTable, token: string): Promise<boolean> {
  if (!plausibleToken(token)) return false;
  const h = hashToken(token);
  const rows =
    table === "password_reset_tokens"
      ? await sql`SELECT 1 FROM password_reset_tokens WHERE token_hash = ${h} AND used_at IS NULL AND expires_at > now()`
      : await sql`SELECT 1 FROM email_verifications WHERE token_hash = ${h} AND used_at IS NULL AND expires_at > now()`;
  return rows.length > 0;
}
