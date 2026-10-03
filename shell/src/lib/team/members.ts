import type postgres from "postgres";
import { checkChangeRole, checkLeave, checkRemove, checkTransfer, isRole, type Decision, type DenyCode, type Role } from "./permissions";

export type Sql = ReturnType<typeof postgres>;
// Inside sql.begin the callback gets a TransactionSql; it is callable the same way, which is all we use.
type Q = Sql;

export interface Member {
  userId: string;
  role: Role;
  joinedAt: string;
  email: string;
  displayName: string;
  lastSeenAt: string | null;
}

export type Failure = { ok: false; code: DenyCode | "not_found" | "invalid"; message: string };
export type Result<T> = ({ ok: true } & T) | Failure;

const fail = (d: Extract<Decision, { ok: false }>): Failure => ({ ok: false, code: d.code, message: d.reason });

/** The caller's role in a business, or null when they are not a member. Always read from the database, never from the client. */
export async function getMembership(sql: Sql, businessId: string, userId: string): Promise<{ role: Role } | null> {
  const [r] = await sql<{ role: string }[]>`SELECT role FROM business_members WHERE business_id = ${businessId} AND user_id = ${userId}`;
  return r && isRole(r.role) ? { role: r.role } : null;
}

export async function listMembers(sql: Sql, businessId: string): Promise<Member[]> {
  const rows = await sql<{ user_id: string; role: string; created_at: Date; email: string | null; display_name: string | null; last_seen_at: Date | null }[]>`
    SELECT m.user_id, m.role, m.created_at, p.email, p.display_name, p.last_seen_at
    FROM business_members m
    LEFT JOIN team_member_profiles p ON p.business_id = m.business_id AND p.user_id = m.user_id
    WHERE m.business_id = ${businessId}
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, m.created_at, m.user_id`;
  return rows.map((r) => ({
    userId: r.user_id,
    role: (isRole(r.role) ? r.role : "viewer") as Role,
    joinedAt: r.created_at.toISOString(),
    email: r.email ?? "",
    displayName: r.display_name ?? "",
    lastSeenAt: r.last_seen_at ? r.last_seen_at.toISOString() : null,
  }));
}

/** Remember what we know about the signed-in user so the owner can recognize them. Only call for the verified current user. */
export async function upsertProfile(sql: Sql, businessId: string, user: { id: string; email: string; displayName: string }): Promise<void> {
  // Only for members: never create a profile row for someone outside the business.
  await sql`
    INSERT INTO team_member_profiles (business_id, user_id, email, display_name, last_seen_at)
    SELECT ${businessId}, ${user.id}, ${user.email.toLowerCase()}, ${user.displayName ?? ""}, now()
    WHERE EXISTS (SELECT 1 FROM business_members WHERE business_id = ${businessId} AND user_id = ${user.id})
    ON CONFLICT (business_id, user_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, last_seen_at = now()`;
}

/** Serialize membership changes per business so the "at least one owner" invariant holds under concurrency. */
async function lockBusiness(tx: Q, businessId: string): Promise<boolean> {
  const rows = await tx`SELECT 1 FROM businesses WHERE id = ${businessId} FOR UPDATE`;
  return rows.length > 0;
}

async function roleOf(tx: Q, businessId: string, userId: string): Promise<Role | null> {
  const [r] = await tx<{ role: string }[]>`SELECT role FROM business_members WHERE business_id = ${businessId} AND user_id = ${userId}`;
  return r && isRole(r.role) ? r.role : null;
}

async function ownerCount(tx: Q, businessId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM business_members WHERE business_id = ${businessId} AND role = 'owner'`;
  return r.n;
}

const notFound: Failure = { ok: false, code: "not_found", message: "Business not found." };

export async function changeRole(sql: Sql, a: { businessId: string; actorId: string; targetUserId: string; newRole: string }): Promise<Result<{ from: Role; to: Role }>> {
  if (!isRole(a.newRole)) return { ok: false, code: "invalid", message: "Unknown role." };
  const newRole = a.newRole;
  return sql.begin(async (tx): Promise<Result<{ from: Role; to: Role }>> => {
    if (!(await lockBusiness(tx as unknown as Q, a.businessId))) return notFound;
    const actorRole = await roleOf(tx as unknown as Q, a.businessId, a.actorId);
    const targetRole = await roleOf(tx as unknown as Q, a.businessId, a.targetUserId);
    const d = checkChangeRole({ actorRole, actorId: a.actorId, targetRole, targetId: a.targetUserId, newRole, ownerCount: await ownerCount(tx as unknown as Q, a.businessId) });
    if (!d.ok) return fail(d);
    await tx`UPDATE business_members SET role = ${newRole} WHERE business_id = ${a.businessId} AND user_id = ${a.targetUserId}`;
    return { ok: true, from: targetRole!, to: newRole };
  });
}

export async function removeMember(sql: Sql, a: { businessId: string; actorId: string; targetUserId: string }): Promise<Result<{ removedRole: Role }>> {
  return sql.begin(async (tx): Promise<Result<{ removedRole: Role }>> => {
    if (!(await lockBusiness(tx as unknown as Q, a.businessId))) return notFound;
    const actorRole = await roleOf(tx as unknown as Q, a.businessId, a.actorId);
    const targetRole = await roleOf(tx as unknown as Q, a.businessId, a.targetUserId);
    const d = checkRemove({ actorRole, actorId: a.actorId, targetRole, targetId: a.targetUserId, ownerCount: await ownerCount(tx as unknown as Q, a.businessId) });
    if (!d.ok) return fail(d);
    await tx`DELETE FROM business_members WHERE business_id = ${a.businessId} AND user_id = ${a.targetUserId}`;
    await tx`DELETE FROM team_member_profiles WHERE business_id = ${a.businessId} AND user_id = ${a.targetUserId}`;
    return { ok: true, removedRole: targetRole! };
  });
}

export async function leaveBusiness(sql: Sql, a: { businessId: string; userId: string }): Promise<Result<{ leftRole: Role }>> {
  return sql.begin(async (tx): Promise<Result<{ leftRole: Role }>> => {
    if (!(await lockBusiness(tx as unknown as Q, a.businessId))) return notFound;
    const role = await roleOf(tx as unknown as Q, a.businessId, a.userId);
    const d = checkLeave(role, await ownerCount(tx as unknown as Q, a.businessId));
    if (!d.ok) return fail(d);
    await tx`DELETE FROM business_members WHERE business_id = ${a.businessId} AND user_id = ${a.userId}`;
    await tx`DELETE FROM team_member_profiles WHERE business_id = ${a.businessId} AND user_id = ${a.userId}`;
    return { ok: true, leftRole: role! };
  });
}

/** The target becomes an owner and the actor steps down to admin, in one transaction. */
export async function transferOwnership(sql: Sql, a: { businessId: string; actorId: string; targetUserId: string }): Promise<Result<{ newOwner: string; previousOwner: string }>> {
  return sql.begin(async (tx): Promise<Result<{ newOwner: string; previousOwner: string }>> => {
    if (!(await lockBusiness(tx as unknown as Q, a.businessId))) return notFound;
    const actorRole = await roleOf(tx as unknown as Q, a.businessId, a.actorId);
    const targetRole = await roleOf(tx as unknown as Q, a.businessId, a.targetUserId);
    const d = checkTransfer({ actorRole, actorId: a.actorId, targetRole, targetId: a.targetUserId });
    if (!d.ok) return fail(d);
    await tx`UPDATE business_members SET role = 'owner' WHERE business_id = ${a.businessId} AND user_id = ${a.targetUserId}`;
    await tx`UPDATE business_members SET role = 'admin' WHERE business_id = ${a.businessId} AND user_id = ${a.actorId}`;
    return { ok: true, newOwner: a.targetUserId, previousOwner: a.actorId };
  });
}

/** Seats in use = members. `limit` is supplied by the caller (billing); null means unlimited. */
export async function seatUsage(sql: Sql, businessId: string, limit: number | null): Promise<{ used: number; limit: number | null; full: boolean }> {
  const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM business_members WHERE business_id = ${businessId}`;
  return { used: r.n, limit, full: limit !== null && r.n >= limit };
}
