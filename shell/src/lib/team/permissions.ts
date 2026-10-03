/**
 * The team permission matrix. Pure functions, no I/O: every server-side check goes through here and the tests pin the behaviour.
 *
 * Roles: owner > admin > member > viewer.
 * - viewer: read-only in every tool.
 * - member: can read and write in tools.
 * - admin: member + manage members (invite / revoke / change roles of members and viewers / remove them) + edit the business profile.
 * - owner: everything, including promoting owners, transferring ownership, deleting the business and managing billing.
 */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (x: unknown): x is Role => typeof x === "string" && (ROLES as readonly string[]).includes(x);

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };
export const ROLE_SUMMARY: Record<Role, string> = {
  owner: "Full control, including billing, ownership and deleting the business.",
  admin: "Manages members and the business profile, and works in every tool.",
  member: "Works in every tool: can view, create and edit.",
  viewer: "Read-only: can view everything, changes nothing.",
};

export type Permission =
  | "team.view"
  | "team.invite"
  | "team.revokeInvite"
  | "team.changeRole"
  | "team.remove"
  | "business.edit"
  | "business.delete"
  | "ownership.transfer"
  | "billing.manage"
  | "tools.read"
  | "tools.write";

const MATRIX: Record<Permission, readonly Role[]> = {
  "team.view": ["owner", "admin", "member", "viewer"],
  "team.invite": ["owner", "admin"],
  "team.revokeInvite": ["owner", "admin"],
  "team.changeRole": ["owner", "admin"],
  "team.remove": ["owner", "admin"],
  "business.edit": ["owner", "admin"],
  "business.delete": ["owner"],
  "ownership.transfer": ["owner"],
  "billing.manage": ["owner"],
  "tools.read": ["owner", "admin", "member", "viewer"],
  "tools.write": ["owner", "admin", "member"],
};

export const PERMISSIONS = Object.keys(MATRIX) as Permission[];

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && MATRIX[permission].includes(role);
}

export function toolAccess(role: Role | null | undefined): { read: boolean; write: boolean } {
  return { read: can(role, "tools.read"), write: can(role, "tools.write") };
}

export type DenyCode =
  | "forbidden"
  | "self"
  | "unchanged"
  | "last_owner"
  | "owner_protected"
  | "role_not_allowed"
  | "not_member";

export type Decision = { ok: true } | { ok: false; code: DenyCode; reason: string };
const OK: Decision = { ok: true };
const no = (code: DenyCode, reason: string): Decision => ({ ok: false, code, reason });

/** Roles an actor may put on a new invite. Owners are never invited: ownership is transferred or granted to an existing member. */
export function invitableRoles(actor: Role | null | undefined): Role[] {
  if (actor === "owner") return ["admin", "member", "viewer"];
  if (actor === "admin") return ["member", "viewer"];
  return [];
}

export function checkInvite(actor: Role | null | undefined, offered: Role): Decision {
  if (!can(actor, "team.invite")) return no("forbidden", "You do not have permission to invite people.");
  if (!invitableRoles(actor).includes(offered)) {
    return no(offered === "owner" ? "owner_protected" : "role_not_allowed", offered === "owner" ? "Owners cannot be invited. Transfer ownership to an existing member instead." : "You cannot offer a role at or above your own.");
  }
  return OK;
}

export interface RoleChange {
  actorRole: Role | null | undefined;
  actorId: string;
  targetRole: Role | null | undefined;
  targetId: string;
  newRole: Role;
  /** Number of owners in the business right now. */
  ownerCount: number;
}

export function checkChangeRole(c: RoleChange): Decision {
  if (!can(c.actorRole, "team.changeRole")) return no("forbidden", "You do not have permission to change roles.");
  if (!c.targetRole) return no("not_member", "That person is not a member of this business.");
  if (c.actorId === c.targetId) return no("self", "You cannot change your own role. Ask another owner or admin.");
  if (c.newRole === c.targetRole) return no("unchanged", "That is already their role.");
  if (c.actorRole === "admin") {
    if (c.targetRole === "owner") return no("owner_protected", "Admins cannot change an owner's role.");
    if (c.newRole === "owner") return no("owner_protected", "Only an owner can make someone an owner.");
    if (c.targetRole === "admin" || c.newRole === "admin") return no("forbidden", "Only an owner can promote to or change an admin.");
  }
  if (c.targetRole === "owner" && c.newRole !== "owner" && c.ownerCount <= 1) return no("last_owner", "A business must always have at least one owner.");
  return OK;
}

export interface Removal {
  actorRole: Role | null | undefined;
  actorId: string;
  targetRole: Role | null | undefined;
  targetId: string;
  ownerCount: number;
}

export function checkRemove(r: Removal): Decision {
  if (!can(r.actorRole, "team.remove")) return no("forbidden", "You do not have permission to remove members.");
  if (!r.targetRole) return no("not_member", "That person is not a member of this business.");
  if (r.actorId === r.targetId) return no("self", "Use Leave business to remove yourself.");
  if (r.actorRole === "admin" && (r.targetRole === "owner" || r.targetRole === "admin")) {
    return no(r.targetRole === "owner" ? "owner_protected" : "forbidden", r.targetRole === "owner" ? "Admins cannot remove an owner." : "Only an owner can remove an admin.");
  }
  if (r.targetRole === "owner" && r.ownerCount <= 1) return no("last_owner", "A business must always have at least one owner.");
  return OK;
}

export function checkLeave(role: Role | null | undefined, ownerCount: number): Decision {
  if (!role) return no("not_member", "You are not a member of this business.");
  if (role === "owner" && ownerCount <= 1) return no("last_owner", "You are the only owner. Transfer ownership to someone else before leaving.");
  return OK;
}

export interface Transfer {
  actorRole: Role | null | undefined;
  actorId: string;
  targetRole: Role | null | undefined;
  targetId: string;
}

/** Transfer: the target becomes owner and the actor steps down to admin (an owner can also simply promote a co-owner). */
export function checkTransfer(t: Transfer): Decision {
  if (!can(t.actorRole, "ownership.transfer")) return no("forbidden", "Only an owner can transfer ownership.");
  if (!t.targetRole) return no("not_member", "That person is not a member of this business.");
  if (t.actorId === t.targetId) return no("self", "You already own this business.");
  if (t.targetRole === "owner") return no("unchanged", "That person is already an owner.");
  return OK;
}
