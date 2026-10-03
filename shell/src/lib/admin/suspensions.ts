import type { Sql } from "@founderos/sdk";

/**
 * User suspension. A suspension blocks a LegalAI account from using the shell; the LEAD wires `isSuspended` into the session check.
 * Limit: the shell only knows the caller's own role, so it can refuse self-suspension but cannot tell whether the target is another admin.
 */

export interface SuspensionRow {
  userId: string;
  reason: string;
  suspendedBy: string;
  suspendedAt: string;
  liftedAt: string | null;
}

const MAX_REASON = 500;
const MAX_ID = 200;

export type SuspendResult = { ok: true } | { ok: false; status: 400 | 409; error: string };

/** True when a suspension row exists for the user and has not been lifted. Fails open (false) only when the table does not exist yet. */
export async function isSuspended(sql: Sql, userId: string): Promise<boolean> {
  if (!userId) return false;
  try {
    const rows = await sql`SELECT 1 FROM platform_suspensions WHERE user_id = ${userId} AND lifted_at IS NULL`;
    return rows.length > 0;
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return false; // migration 0007 not applied yet
    throw e;
  }
}

/** Pure validation shared by the API and the library. */
export function validateReason(reason: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const r = typeof reason === "string" ? reason.trim() : "";
  if (!r) return { ok: false, error: "A reason is required" };
  if (r.length > MAX_REASON) return { ok: false, error: `Reason must be ${MAX_REASON} characters or fewer` };
  return { ok: true, reason: r };
}

/** Suspend a user. Refuses an empty reason, an empty or oversized id, self-suspension, and a user who is already suspended. */
export async function suspendUser(sql: Sql, input: { userId: string; reason: string; suspendedBy: string }): Promise<SuspendResult> {
  const userId = (input.userId ?? "").trim();
  if (!userId || userId.length > MAX_ID) return { ok: false, status: 400, error: "Invalid user" };
  if (userId === input.suspendedBy) return { ok: false, status: 400, error: "You cannot suspend your own account" };
  const v = validateReason(input.reason);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const rows = await sql`
    INSERT INTO platform_suspensions (user_id, reason, suspended_by, suspended_at, lifted_at)
    VALUES (${userId}, ${v.reason}, ${input.suspendedBy}, now(), NULL)
    ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, suspended_by = EXCLUDED.suspended_by, suspended_at = now(), lifted_at = NULL
      WHERE platform_suspensions.lifted_at IS NOT NULL
    RETURNING user_id`;
  return rows.length ? { ok: true } : { ok: false, status: 409, error: "That user is already suspended" };
}

/** Lift an active suspension. Returns false when there was none. */
export async function liftSuspension(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql`UPDATE platform_suspensions SET lifted_at = now() WHERE user_id = ${userId} AND lifted_at IS NULL RETURNING user_id`;
  return rows.length > 0;
}

type Raw = { user_id: string; reason: string; suspended_by: string; suspended_at: Date; lifted_at: Date | null };
const toRow = (r: Raw): SuspensionRow => ({
  userId: r.user_id, reason: r.reason, suspendedBy: r.suspended_by, suspendedAt: r.suspended_at.toISOString(), liftedAt: r.lifted_at?.toISOString() ?? null,
});

export async function listSuspensions(sql: Sql, opts: { activeOnly?: boolean; limit?: number } = {}): Promise<SuspensionRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const rows = opts.activeOnly
    ? await sql<Raw[]>`SELECT * FROM platform_suspensions WHERE lifted_at IS NULL ORDER BY suspended_at DESC LIMIT ${limit}`
    : await sql<Raw[]>`SELECT * FROM platform_suspensions ORDER BY suspended_at DESC LIMIT ${limit}`;
  return rows.map(toRow);
}

export async function countActiveSuspensions(sql: Sql): Promise<number> {
  try {
    const [r] = await sql<{ n: string }[]>`SELECT count(*) AS n FROM platform_suspensions WHERE lifted_at IS NULL`;
    return Number(r.n);
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return 0;
    throw e;
  }
}

export interface AdminUserRow {
  userId: string;
  email: string | null;
  displayName: string | null;
  businesses: number;
  lastSeenAt: string | null;
  suspended: boolean;
  suspendedReason: string | null;
}

/**
 * Users the shell knows: distinct business_members.user_id (plus anyone with a suspension row), with email and display name from
 * team_member_profiles when that table exists. Counts and profile fields only; never any business content.
 */
export async function listUsers(sql: Sql, opts: { search?: string; limit?: number } = {}): Promise<AdminUserRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const q = opts.search?.trim() ? `%${opts.search.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
  const [{ ok: hasProfiles }] = await sql<{ ok: boolean }[]>`SELECT to_regclass('team_member_profiles') IS NOT NULL AS ok`;
  const [{ ok: hasSusp }] = await sql<{ ok: boolean }[]>`SELECT to_regclass('platform_suspensions') IS NOT NULL AS ok`;
  const profiles = hasProfiles
    ? sql`SELECT user_id, max(last_seen_at) AS last_seen, (array_agg(NULLIF(email, '') ORDER BY last_seen_at DESC))[1] AS email,
                 (array_agg(NULLIF(display_name, '') ORDER BY last_seen_at DESC))[1] AS display_name FROM team_member_profiles GROUP BY user_id`
    : sql`SELECT NULL::text AS user_id, NULL::timestamptz AS last_seen, NULL::text AS email, NULL::text AS display_name WHERE false`;
  const susp = hasSusp
    ? sql`SELECT user_id, reason FROM platform_suspensions WHERE lifted_at IS NULL`
    : sql`SELECT NULL::text AS user_id, NULL::text AS reason WHERE false`;
  const rows = await sql<{ user_id: string; businesses: string; last_seen: Date | null; email: string | null; display_name: string | null; reason: string | null; suspended: boolean }[]>`
    WITH ids AS (
      SELECT user_id, count(DISTINCT business_id) AS businesses FROM business_members GROUP BY user_id
      UNION ALL
      SELECT user_id, 0 FROM (${susp}) s0 WHERE user_id NOT IN (SELECT user_id FROM business_members)
    )
    SELECT i.user_id, i.businesses, p.last_seen, p.email, p.display_name, s.reason, (s.user_id IS NOT NULL) AS suspended
    FROM ids i LEFT JOIN (${profiles}) p ON p.user_id = i.user_id LEFT JOIN (${susp}) s ON s.user_id = i.user_id
    WHERE (${q}::text IS NULL OR i.user_id ILIKE ${q} OR p.email ILIKE ${q} OR p.display_name ILIKE ${q})
    ORDER BY (s.user_id IS NOT NULL) DESC, p.last_seen DESC NULLS LAST, i.user_id LIMIT ${limit}`;
  return rows.map((r) => ({
    userId: r.user_id, email: r.email, displayName: r.display_name, businesses: Number(r.businesses),
    lastSeenAt: r.last_seen?.toISOString() ?? null, suspended: r.suspended, suspendedReason: r.reason,
  }));
}
