import { describe, expect, it } from "vitest";
import {
  ROLES, can, checkChangeRole, checkInvite, checkLeave, checkRemove, checkTransfer, invitableRoles, toolAccess, type Permission, type Role,
} from "@/lib/team/permissions";

const MATRIX: [Permission, Record<Role, boolean>][] = [
  ["team.view", { owner: true, admin: true, member: true, viewer: true }],
  ["team.invite", { owner: true, admin: true, member: false, viewer: false }],
  ["team.revokeInvite", { owner: true, admin: true, member: false, viewer: false }],
  ["team.changeRole", { owner: true, admin: true, member: false, viewer: false }],
  ["team.remove", { owner: true, admin: true, member: false, viewer: false }],
  ["business.edit", { owner: true, admin: true, member: false, viewer: false }],
  ["business.delete", { owner: true, admin: false, member: false, viewer: false }],
  ["ownership.transfer", { owner: true, admin: false, member: false, viewer: false }],
  ["billing.manage", { owner: true, admin: false, member: false, viewer: false }],
  ["tools.read", { owner: true, admin: true, member: true, viewer: true }],
  ["tools.write", { owner: true, admin: true, member: true, viewer: false }],
];

describe("permission matrix", () => {
  for (const [perm, expected] of MATRIX) {
    for (const role of ROLES) it(`${role} ${expected[role] ? "can" : "cannot"} ${perm}`, () => expect(can(role, perm)).toBe(expected[role]));
  }
  it("no role means no permission", () => {
    expect(can(null, "team.view")).toBe(false);
    expect(can(undefined, "tools.read")).toBe(false);
  });
  it("tool access: viewer is read-only, member can write", () => {
    expect(toolAccess("viewer")).toEqual({ read: true, write: false });
    expect(toolAccess("member")).toEqual({ read: true, write: true });
    expect(toolAccess(null)).toEqual({ read: false, write: false });
  });
});

describe("invites", () => {
  it.each([
    ["owner", "admin", true], ["owner", "member", true], ["owner", "viewer", true], ["owner", "owner", false],
    ["admin", "member", true], ["admin", "viewer", true], ["admin", "admin", false], ["admin", "owner", false],
    ["member", "viewer", false], ["viewer", "viewer", false],
  ] as [Role, Role, boolean][])("%s inviting %s -> %s", (actor, offered, ok) => expect(checkInvite(actor, offered).ok).toBe(ok));
  it("lists invitable roles", () => {
    expect(invitableRoles("owner")).toEqual(["admin", "member", "viewer"]);
    expect(invitableRoles("admin")).toEqual(["member", "viewer"]);
    expect(invitableRoles("member")).toEqual([]);
  });
});

const change = (actorRole: Role, targetRole: Role, newRole: Role, o: { same?: boolean; owners?: number } = {}) =>
  checkChangeRole({ actorRole, actorId: "a", targetRole, targetId: o.same ? "a" : "t", newRole, ownerCount: o.owners ?? 2 });

describe("change role", () => {
  it.each([
    ["owner", "member", "admin", true], ["owner", "admin", "viewer", true], ["owner", "member", "owner", true], ["owner", "owner", "member", true],
    ["admin", "member", "viewer", true], ["admin", "viewer", "member", true],
    ["admin", "member", "admin", false], ["admin", "member", "owner", false], ["admin", "owner", "member", false], ["admin", "admin", "member", false],
    ["member", "viewer", "member", false], ["viewer", "member", "viewer", false],
  ] as [Role, Role, Role, boolean][])("%s changes %s to %s -> %s", (a, t, n, ok) => expect(change(a, t, n).ok).toBe(ok));

  it("nobody changes their own role", () => {
    for (const r of ROLES) expect(change("owner", r, "viewer", { same: true })).toMatchObject({ ok: false, code: "self" });
    expect(change("admin", "admin", "member", { same: true })).toMatchObject({ ok: false, code: "self" });
  });
  it("never demotes the last owner", () => expect(change("owner", "owner", "admin", { owners: 1 })).toMatchObject({ ok: false, code: "last_owner" }));
  it("an admin cannot touch an owner", () => expect(change("admin", "owner", "viewer")).toMatchObject({ ok: false, code: "owner_protected" }));
  it("rejects a non-member target and a no-op", () => {
    expect(checkChangeRole({ actorRole: "owner", actorId: "a", targetRole: null, targetId: "t", newRole: "member", ownerCount: 1 })).toMatchObject({ code: "not_member" });
    expect(change("owner", "member", "member")).toMatchObject({ code: "unchanged" });
  });
});

describe("remove / leave / transfer", () => {
  const rm = (actorRole: Role, targetRole: Role, o: { same?: boolean; owners?: number } = {}) =>
    checkRemove({ actorRole, actorId: "a", targetRole, targetId: o.same ? "a" : "t", ownerCount: o.owners ?? 2 });
  it.each([
    ["owner", "admin", true], ["owner", "member", true], ["owner", "owner", true], ["admin", "member", true], ["admin", "viewer", true],
    ["admin", "admin", false], ["admin", "owner", false], ["member", "viewer", false], ["viewer", "viewer", false],
  ] as [Role, Role, boolean][])("%s removes %s -> %s", (a, t, ok) => expect(rm(a, t).ok).toBe(ok));
  it("cannot remove yourself or the last owner", () => {
    expect(rm("owner", "owner", { same: true })).toMatchObject({ code: "self" });
    expect(rm("owner", "owner", { owners: 1 })).toMatchObject({ code: "last_owner" });
  });
  it("leaving: last owner cannot leave, others can", () => {
    expect(checkLeave("owner", 1)).toMatchObject({ ok: false, code: "last_owner" });
    expect(checkLeave("owner", 2).ok).toBe(true);
    for (const r of ["admin", "member", "viewer"] as Role[]) expect(checkLeave(r, 1).ok).toBe(true);
    expect(checkLeave(null, 1)).toMatchObject({ code: "not_member" });
  });
  it("only owners transfer ownership, to another member", () => {
    const t = (actorRole: Role, targetRole: Role | null, same = false) => checkTransfer({ actorRole, actorId: "a", targetRole, targetId: same ? "a" : "t" });
    expect(t("owner", "admin").ok).toBe(true);
    expect(t("owner", "viewer").ok).toBe(true);
    expect(t("admin", "member").ok).toBe(false);
    expect(t("owner", "member", true)).toMatchObject({ code: "self" });
    expect(t("owner", null)).toMatchObject({ code: "not_member" });
    expect(t("owner", "owner")).toMatchObject({ code: "unchanged" });
  });
});
