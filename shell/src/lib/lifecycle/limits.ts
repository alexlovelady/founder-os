import type { Sql } from "@founderos/sdk";
import { hashId } from "@/lib/signup/limits";

export type AttemptKind = "forgot" | "resend" | "reset" | "verify" | "delete";

/** Per hour. `subject` is the hashed email (or hashed user id for delete). Every attempt counts, successful or not. */
export const LIFECYCLE_LIMITS: Record<AttemptKind, { ip: number; subject: number }> = {
  forgot: { ip: 5, subject: 3 },
  resend: { ip: 5, subject: 3 },
  reset: { ip: 20, subject: 1000 },
  verify: { ip: 30, subject: 1000 },
  delete: { ip: 10, subject: 5 },
};

export type Env = Record<string, string | undefined>;

/** Same keyed hash as signup (HMAC-SHA-256 with SIGNUP_HASH_SECRET or the provisioning token). Never stores a raw address or id. */
export const hashSubject = (value: string, env: Env = process.env): string => hashId("email", value, env);
export const hashIp = (ip: string, env: Env = process.env): string => hashId("ip", ip, env);

export interface LimitResult { ok: boolean; reason?: "ip" | "subject" }

/** Check both windows and record the attempt under advisory locks, so parallel requests cannot slip past the count. */
export async function checkAndRecord(sql: Sql, kind: AttemptKind, ipHash: string, subjectHash: string | null): Promise<LimitResult> {
  const lim = LIFECYCLE_LIMITS[kind];
  return sql.begin(async (tx) => {
    for (const k of [`${kind}:${ipHash}`, ...(subjectHash ? [`${kind}:${subjectHash}`] : [])].sort()) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${k}, 0))`;
    const [c] = await tx<{ ip: number; subject: number }[]>`
      SELECT count(*) FILTER (WHERE ip_hash = ${ipHash})::int AS ip, count(*) FILTER (WHERE subject_hash = ${subjectHash})::int AS subject
      FROM lifecycle_attempts WHERE kind = ${kind} AND created_at > now() - interval '1 hour' AND (ip_hash = ${ipHash} OR subject_hash = ${subjectHash})`;
    if (c.ip >= lim.ip) return { ok: false, reason: "ip" } as LimitResult;
    if (subjectHash && c.subject >= lim.subject) return { ok: false, reason: "subject" } as LimitResult;
    await tx`INSERT INTO lifecycle_attempts (kind, ip_hash, subject_hash) VALUES (${kind}, ${ipHash}, ${subjectHash})`;
    return { ok: true } as LimitResult;
  }) as Promise<LimitResult>;
}

/** Housekeeping, called opportunistically and by the scheduled cleanup: attempts older than 30 days, spent tokens older than 7 days. */
export async function pruneLifecycle(sql: Sql): Promise<void> {
  try {
    await sql`DELETE FROM lifecycle_attempts WHERE created_at < now() - interval '30 days'`;
    await sql`DELETE FROM password_reset_tokens WHERE (used_at IS NOT NULL OR expires_at < now()) AND created_at < now() - interval '7 days'`;
  } catch {
    /* best effort */
  }
}
