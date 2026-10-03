import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { checkInvite, isRole, can, type Role } from "./permissions";
import { upsertProfile, type Failure, type Result, type Sql } from "./members";

type Q = Sql;

export const DEFAULT_EXPIRY_DAYS = 7;
export const MAX_EXPIRY_DAYS = 30;
export const MAX_USES_LIMIT = 50;
export const MAX_ACTIVE_INVITES = 50;

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const newToken = (): string => randomBytes(32).toString("base64url");
const looksLikeToken = (t: string) => /^[A-Za-z0-9_-]{20,100}$/.test(t);

/** Constant-time comparison of two hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const normalizeEmail = (e: string | null | undefined): string | null => {
  const v = (e ?? "").trim().toLowerCase();
  return v ? v : null;
};

export type InviteStatus = "active" | "expired" | "revoked" | "used";

export interface InviteSummary {
  id: string;
  role: Role;
  email: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  maxUses: number;
  useCount: number;
  acceptedBy: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: InviteStatus;
}

interface InviteRow {
  id: string; business_id: string; role: string; token_hash: string; email: string | null; created_by: string; created_at: Date; expires_at: Date;
  accepted_by: string | null; accepted_at: Date | null; revoked_at: Date | null; max_uses: number; use_count: number;
}

function statusOf(r: Pick<InviteRow, "revoked_at" | "expires_at" | "use_count" | "max_uses">, now = new Date()): InviteStatus {
  if (r.revoked_at) return "revoked";
  if (r.use_count >= r.max_uses) return "used";
  if (r.expires_at.getTime() <= now.getTime()) return "expired";
  return "active";
}

const summary = (r: InviteRow): InviteSummary => ({
  id: r.id, role: r.role as Role, email: r.email, createdBy: r.created_by, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(),
  maxUses: r.max_uses, useCount: r.use_count, acceptedBy: r.accepted_by, acceptedAt: r.accepted_at ? r.accepted_at.toISOString() : null,
  revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null, status: statusOf(r),
});

const forbidden = (message: string): Failure => ({ ok: false, code: "forbidden", message });

async function actorRole(sql: Sql, businessId: string, actorId: string): Promise<Role | null> {
  const [r] = await sql<{ role: string }[]>`SELECT role FROM business_members WHERE business_id = ${businessId} AND user_id = ${actorId}`;
  return r && isRole(r.role) ? r.role : null;
}

export interface CreateInviteArgs {
  businessId: string;
  actorId: string;
  role: string;
  /** Optional: only a signed-in user with this email may accept. */
  email?: string | null;
  expiresInDays?: number;
  maxUses?: number;
}

/** Creates an invite. The raw token is returned ONCE here and is never stored (only its SHA-256 hash is). */
export async function createInvite(sql: Sql, a: CreateInviteArgs): Promise<Result<{ invite: InviteSummary; token: string; path: string }>> {
  if (!isRole(a.role)) return { ok: false, code: "invalid", message: "Unknown role." };
  const email = normalizeEmail(a.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, code: "invalid", message: "That email address does not look right." };
  const days = Math.min(Math.max(Math.floor(a.expiresInDays ?? DEFAULT_EXPIRY_DAYS), 1), MAX_EXPIRY_DAYS);
  const maxUses = Math.min(Math.max(Math.floor(a.maxUses ?? 1), 1), MAX_USES_LIMIT);

  const role = await actorRole(sql, a.businessId, a.actorId);
  const d = checkInvite(role, a.role);
  if (!d.ok) return { ok: false, code: d.code, message: d.reason };

  const [{ n }] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM team_invites
    WHERE business_id = ${a.businessId} AND revoked_at IS NULL AND use_count < max_uses AND expires_at > now()`;
  if (n >= MAX_ACTIVE_INVITES) return { ok: false, code: "invalid", message: "Too many open invites. Revoke some first." };

  const token = newToken();
  const [row] = await sql<InviteRow[]>`
    INSERT INTO team_invites (business_id, role, token_hash, email, created_by, expires_at, max_uses)
    VALUES (${a.businessId}, ${a.role}, ${hashToken(token)}, ${email}, ${a.actorId}, now() + make_interval(days => ${days}), ${maxUses})
    RETURNING *`;
  return { ok: true, invite: summary(row), token, path: `/invite/${token}` };
}

/** Invites of a business. Only people who can invite may see them. */
export async function listInvites(sql: Sql, businessId: string, actorId: string): Promise<Result<{ invites: InviteSummary[] }>> {
  const role = await actorRole(sql, businessId, actorId);
  if (!can(role, "team.invite")) return forbidden("You do not have permission to see invites.");
  const rows = await sql<InviteRow[]>`SELECT * FROM team_invites WHERE business_id = ${businessId} ORDER BY created_at DESC LIMIT 100`;
  return { ok: true, invites: rows.map(summary) };
}

export async function revokeInvite(sql: Sql, a: { businessId: string; actorId: string; inviteId: string }): Promise<Result<{ invite: InviteSummary }>> {
  const role = await actorRole(sql, a.businessId, a.actorId);
  if (!can(role, "team.revokeInvite")) return forbidden("You do not have permission to revoke invites.");
  if (!/^[0-9a-f-]{36}$/i.test(a.inviteId)) return { ok: false, code: "not_found", message: "Invite not found." };
  // Scoped by business_id: an id from another business simply matches nothing.
  const [row] = await sql<InviteRow[]>`
    UPDATE team_invites SET revoked_at = COALESCE(revoked_at, now()) WHERE id = ${a.inviteId} AND business_id = ${a.businessId} RETURNING *`;
  if (!row) return { ok: false, code: "not_found", message: "Invite not found." };
  return { ok: true, invite: summary(row) };
}

/** Which business a token belongs to (for looking up that business's plan limits before accepting). */
export async function inviteBusinessId(sql: Sql, token: string): Promise<string | null> {
  if (!looksLikeToken(token)) return null;
  const [r] = await sql<{ business_id: string }[]>`SELECT business_id FROM team_invites WHERE token_hash = ${hashToken(token)}`;
  return r?.business_id ?? null;
}

export type InviteProblem = "not_found" | "revoked" | "expired" | "exhausted" | "email_mismatch" | "already_member" | "seat_limit";
const PROBLEM_TEXT: Record<InviteProblem, string> = {
  not_found: "This invite link is not valid.",
  revoked: "This invite was revoked. Ask the business owner for a new one.",
  expired: "This invite has expired. Ask the business owner for a new one.",
  exhausted: "This invite has already been used. Ask the business owner for a new one.",
  email_mismatch: "This invite was issued for a different email address. Sign in with the invited account.",
  already_member: "You are already a member of this business.",
  seat_limit: "This business has reached its plan's seat limit. Ask the owner to upgrade the plan or free a seat.",
};
export const problemText = (p: InviteProblem) => PROBLEM_TEXT[p];

export type InvitePreview =
  | { ok: true; businessName: string; role: Role; email: string | null; expiresAt: string }
  | { ok: false; problem: InviteProblem; message: string };

/** What the invite page shows. Call only for a signed-in user; reveals the business name and offered role, nothing else. */
export async function previewInvite(sql: Sql, token: string, user?: { id: string; email: string }): Promise<InvitePreview> {
  const bad = (problem: InviteProblem): InvitePreview => ({ ok: false, problem, message: PROBLEM_TEXT[problem] });
  if (!looksLikeToken(token)) return bad("not_found");
  const hash = hashToken(token);
  const [r] = await sql<(InviteRow & { business_name: string })[]>`
    SELECT i.*, b.name AS business_name FROM team_invites i JOIN businesses b ON b.id = i.business_id WHERE i.token_hash = ${hash}`;
  if (!r || !hashesEqual(r.token_hash, hash)) return bad("not_found");
  const s = statusOf(r);
  if (s === "revoked") return bad("revoked");
  if (s === "expired") return bad("expired");
  if (s === "used") return bad("exhausted");
  if (user) {
    const invited = normalizeEmail(r.email);
    if (invited && invited !== normalizeEmail(user.email)) return bad("email_mismatch");
    const [m] = await sql`SELECT 1 FROM business_members WHERE business_id = ${r.business_id} AND user_id = ${user.id}`;
    if (m) return bad("already_member");
  }
  return { ok: true, businessName: r.business_name, role: r.role as Role, email: r.email, expiresAt: r.expires_at.toISOString() };
}

export type AcceptResult =
  | { ok: true; businessId: string; businessName: string; role: Role; inviteId: string; invitedBy: string; usesLeft: number }
  | { ok: false; problem: InviteProblem; message: string; businessId?: string };

/**
 * Accept an invite as the signed-in user. Validates (not expired / revoked, uses left, email match, not already a member, seat limit) and then
 * inserts the membership and bumps the use count in one transaction, holding the business row lock, so concurrent accepts cannot exceed
 * max_uses or the seat limit. `seatLimit` null = unlimited (the caller derives it from the plan).
 */
export async function acceptInvite(
  sql: Sql,
  args: { token: string; user: { id: string; email: string; displayName?: string }; seatLimit: number | null },
): Promise<AcceptResult> {
  const bad = (problem: InviteProblem, businessId?: string): AcceptResult => ({ ok: false, problem, message: PROBLEM_TEXT[problem], businessId });
  if (!looksLikeToken(args.token)) return bad("not_found");
  const hash = hashToken(args.token);
  const [probe] = await sql<{ business_id: string; token_hash: string }[]>`SELECT business_id, token_hash FROM team_invites WHERE token_hash = ${hash}`;
  if (!probe || !hashesEqual(probe.token_hash, hash)) return bad("not_found");

  const result = await sql.begin(async (tx): Promise<AcceptResult> => {
    const t = tx as unknown as Q;
    // Lock order everywhere: business row first, then the invite.
    const [biz] = await t<{ name: string }[]>`SELECT name FROM businesses WHERE id = ${probe.business_id} FOR UPDATE`;
    if (!biz) return bad("not_found");
    const [inv] = await t<InviteRow[]>`SELECT * FROM team_invites WHERE token_hash = ${hash} AND business_id = ${probe.business_id} FOR UPDATE`;
    if (!inv) return bad("not_found");
    const s = statusOf(inv);
    if (s === "revoked") return bad("revoked");
    if (s === "expired") return bad("expired");
    if (s === "used") return bad("exhausted");
    const invited = normalizeEmail(inv.email);
    if (invited && invited !== normalizeEmail(args.user.email)) return bad("email_mismatch");
    const [already] = await t`SELECT 1 FROM business_members WHERE business_id = ${inv.business_id} AND user_id = ${args.user.id}`;
    if (already) return bad("already_member", inv.business_id);
    const [{ n }] = await t<{ n: number }[]>`SELECT count(*)::int AS n FROM business_members WHERE business_id = ${inv.business_id}`;
    if (args.seatLimit !== null && n >= args.seatLimit) return bad("seat_limit", inv.business_id);
    await t`INSERT INTO business_members (business_id, user_id, role) VALUES (${inv.business_id}, ${args.user.id}, ${inv.role})`;
    await t`UPDATE team_invites SET use_count = use_count + 1, accepted_by = ${args.user.id}, accepted_at = now() WHERE id = ${inv.id}`;
    return { ok: true, businessId: inv.business_id, businessName: biz.name, role: inv.role as Role, inviteId: inv.id, invitedBy: inv.created_by, usesLeft: inv.max_uses - inv.use_count - 1 };
  });
  if (result.ok) await upsertProfile(sql, result.businessId, { id: args.user.id, email: args.user.email, displayName: args.user.displayName ?? "" });
  return result;
}
