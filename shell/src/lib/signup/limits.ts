import { createHmac } from "node:crypto";
import type { Sql } from "@founderos/sdk";

export const IP_LIMIT_PER_HOUR = 5;
export const EMAIL_LIMIT_PER_HOUR = 3;

export type Outcome = "started" | "created" | "invalid_code" | "duplicate" | "unavailable" | "failed";

/**
 * Keyed hash (HMAC-SHA-256) so a stored hash of an IPv4 address or an email cannot be reversed by brute force without the key.
 * Key: SIGNUP_HASH_SECRET, else INTERNAL_PROVISION_TOKEN, else a fixed development value. Rotating the key only resets the rate limit windows.
 */
export function hashId(kind: "ip" | "email", value: string, env: Record<string, string | undefined> = process.env): string {
  const key = env.SIGNUP_HASH_SECRET || env.INTERNAL_PROVISION_TOKEN || "founderos-dev-signup-hash";
  return createHmac("sha256", key).update(`${kind}:${value.trim().toLowerCase()}`).digest("hex");
}

/**
 * The caller's IP. Behind a proxy the right-most X-Forwarded-For entries are the ones the proxies appended; the left side is client-controlled
 * and spoofable. SIGNUP_TRUSTED_PROXY_HOPS (default 1) says how many proxies sit in front of the shell. With no header: "unknown" (one shared bucket).
 */
export function clientIp(headers: Pick<Headers, "get">, env: Record<string, string | undefined> = process.env): string {
  const hops = Math.max(1, Number(env.SIGNUP_TRUSTED_PROXY_HOPS ?? 1) || 1);
  const xff = (headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (xff.length) return xff[Math.max(0, xff.length - hops)].slice(0, 64);
  return (headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64) || "unknown";
}

export interface LimitResult { ok: boolean; attemptId?: number; reason?: "ip" | "email" }

/**
 * Checks both windows and, when allowed, records the attempt, all under advisory locks on both hashes so parallel requests cannot slip past
 * the count. Every attempt counts (including ones that later fail) so failures cannot be retried for free.
 */
export async function checkAndRecordAttempt(sql: Sql, ipHash: string, emailHash: string): Promise<LimitResult> {
  return sql.begin(async (tx) => {
    for (const k of [ipHash, emailHash].sort()) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
    const [c] = await tx<{ ip: number; email: number }[]>`
      SELECT count(*) FILTER (WHERE ip_hash = ${ipHash})::int AS ip, count(*) FILTER (WHERE email_hash = ${emailHash})::int AS email
      FROM signup_attempts WHERE created_at > now() - interval '1 hour' AND (ip_hash = ${ipHash} OR email_hash = ${emailHash})`;
    if (c.ip >= IP_LIMIT_PER_HOUR) return { ok: false, reason: "ip" } as LimitResult;
    if (c.email >= EMAIL_LIMIT_PER_HOUR) return { ok: false, reason: "email" } as LimitResult;
    const [r] = await tx<{ id: string }[]>`INSERT INTO signup_attempts (ip_hash, email_hash, outcome) VALUES (${ipHash}, ${emailHash}, 'started') RETURNING id`;
    return { ok: true, attemptId: Number(r.id) } as LimitResult;
  }) as Promise<LimitResult>;
}

export async function setOutcome(sql: Sql, attemptId: number, outcome: Outcome): Promise<void> {
  try {
    await sql`UPDATE signup_attempts SET outcome = ${outcome} WHERE id = ${attemptId}`;
  } catch {
    /* auditing must not break signup */
  }
}

/** Old attempts are only useful inside the window; trims rows older than 30 days (called opportunistically). */
export async function pruneAttempts(sql: Sql): Promise<void> {
  try {
    await sql`DELETE FROM signup_attempts WHERE created_at < now() - interval '30 days'`;
  } catch {
    /* best effort */
  }
}

export interface AttemptStats { outcome: string; n: number }
export async function recentAttemptStats(sql: Sql): Promise<AttemptStats[]> {
  const rows = await sql<{ outcome: string; n: number }[]>`
    SELECT outcome, count(*)::int AS n FROM signup_attempts WHERE created_at > now() - interval '24 hours' GROUP BY outcome ORDER BY n DESC`;
  return rows;
}
