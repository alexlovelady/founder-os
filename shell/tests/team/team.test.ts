import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { acceptInvite, createInvite, hashToken, listInvites, previewInvite, revokeInvite } from "@/lib/team/invites";
import { changeRole, getMembership, leaveBusiness, listMembers, removeMember, seatUsage, transferOwnership, upsertProfile } from "@/lib/team/members";
import { resolveActiveBusinessId } from "@/lib/team/active";

let env: TestEnv;
const created: string[] = [];
beforeAll(async () => { env = await makeTestEnv([]); });
afterAll(async () => {
  if (created.length) await env.sql`DELETE FROM businesses WHERE id IN ${env.sql(created)}`;
  await env.cleanup();
});

const uid = () => `u-${Math.random().toString(36).slice(2, 10)}`;

/** A fresh business with an owner, and helpers to add members. */
async function biz(name = "Team Co") {
  const [b] = await env.sql<{ id: string }[]>`INSERT INTO businesses (name) VALUES (${name}) RETURNING id`;
  created.push(b.id);
  const owner = uid();
  await env.sql`INSERT INTO business_members (business_id, user_id, role) VALUES (${b.id}, ${owner}, 'owner')`;
  const add = async (role: string) => {
    const id = uid();
    await env.sql`INSERT INTO business_members (business_id, user_id, role) VALUES (${b.id}, ${id}, ${role})`;
    return id;
  };
  return { id: b.id, owner, add };
}
const user = (id = uid(), email = `${id}@example.com`) => ({ id, email, displayName: "Test Person" });
const roleOf = async (b: string, u: string) => (await getMembership(env.sql, b, u))?.role ?? null;

describe("member invariants", () => {
  it("self role change is refused", async () => {
    const b = await biz();
    const r = await changeRole(env.sql, { businessId: b.id, actorId: b.owner, targetUserId: b.owner, newRole: "member" });
    expect(r).toMatchObject({ ok: false, code: "self" });
    expect(await roleOf(b.id, b.owner)).toBe("owner");
  });
  it("the last owner cannot leave; after a transfer the old owner can", async () => {
    const b = await biz();
    expect(await leaveBusiness(env.sql, { businessId: b.id, userId: b.owner })).toMatchObject({ ok: false, code: "last_owner" });
    const m = await b.add("member");
    const t = await transferOwnership(env.sql, { businessId: b.id, actorId: b.owner, targetUserId: m });
    expect(t).toMatchObject({ ok: true, newOwner: m, previousOwner: b.owner });
    expect(await roleOf(b.id, m)).toBe("owner");
    expect(await roleOf(b.id, b.owner)).toBe("admin");
    expect(await leaveBusiness(env.sql, { businessId: b.id, userId: b.owner })).toMatchObject({ ok: true });
    expect(await roleOf(b.id, b.owner)).toBeNull();
  });
  it("an admin cannot demote, remove or promote to owner", async () => {
    const b = await biz();
    const admin = await b.add("admin");
    const member = await b.add("member");
    expect(await changeRole(env.sql, { businessId: b.id, actorId: admin, targetUserId: b.owner, newRole: "viewer" })).toMatchObject({ ok: false, code: "owner_protected" });
    expect(await removeMember(env.sql, { businessId: b.id, actorId: admin, targetUserId: b.owner })).toMatchObject({ ok: false });
    expect(await changeRole(env.sql, { businessId: b.id, actorId: admin, targetUserId: member, newRole: "owner" })).toMatchObject({ ok: false });
    expect(await transferOwnership(env.sql, { businessId: b.id, actorId: admin, targetUserId: member })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await changeRole(env.sql, { businessId: b.id, actorId: admin, targetUserId: member, newRole: "viewer" })).toMatchObject({ ok: true, from: "member", to: "viewer" });
    expect(await removeMember(env.sql, { businessId: b.id, actorId: admin, targetUserId: member })).toMatchObject({ ok: true });
    expect(await roleOf(b.id, b.owner)).toBe("owner");
  });
  it("members and viewers cannot manage anyone", async () => {
    const b = await biz();
    const m = await b.add("member");
    const v = await b.add("viewer");
    expect(await changeRole(env.sql, { businessId: b.id, actorId: m, targetUserId: v, newRole: "member" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await removeMember(env.sql, { businessId: b.id, actorId: v, targetUserId: m })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await createInvite(env.sql, { businessId: b.id, actorId: m, role: "viewer" })).toMatchObject({ ok: false, code: "forbidden" });
  });
  it("the owner can remove a member, and the profile goes too", async () => {
    const b = await biz();
    const m = await b.add("member");
    await upsertProfile(env.sql, b.id, user(m));
    expect((await listMembers(env.sql, b.id)).find((x) => x.userId === m)?.email).toContain("@");
    expect(await removeMember(env.sql, { businessId: b.id, actorId: b.owner, targetUserId: m })).toMatchObject({ ok: true, removedRole: "member" });
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int n FROM team_member_profiles WHERE business_id = ${b.id} AND user_id = ${m}`;
    expect(n).toBe(0);
  });
  it("concurrent owner demotions cannot leave a business without an owner", async () => {
    const b = await biz();
    const o2 = await b.add("owner");
    const results = await Promise.all([
      changeRole(env.sql, { businessId: b.id, actorId: b.owner, targetUserId: o2, newRole: "member" }),
      changeRole(env.sql, { businessId: b.id, actorId: o2, targetUserId: b.owner, newRole: "member" }),
    ]);
    expect(results.filter((r) => r.ok).length).toBe(1);
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int n FROM business_members WHERE business_id = ${b.id} AND role = 'owner'`;
    expect(n).toBe(1);
  });
  it("profiles are only stored for members", async () => {
    const b = await biz();
    const stranger = user();
    await upsertProfile(env.sql, b.id, stranger);
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int n FROM team_member_profiles WHERE business_id = ${b.id} AND user_id = ${stranger.id}`;
    expect(n).toBe(0);
    await upsertProfile(env.sql, b.id, { id: b.owner, email: "Boss@Example.com", displayName: "Boss" });
    expect((await listMembers(env.sql, b.id))[0]).toMatchObject({ email: "boss@example.com", displayName: "Boss" });
  });
});

describe("invite lifecycle", () => {
  it("creates an invite, stores only the hash, and returns the link once", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.path).toBe(`/invite/${r.token}`);
    expect(r.token.length).toBeGreaterThanOrEqual(40);
    const [row] = await env.sql<{ token_hash: string }[]>`SELECT token_hash FROM team_invites WHERE id = ${r.invite.id}`;
    expect(row.token_hash).toBe(hashToken(r.token));
    expect(row.token_hash).not.toBe(r.token);
    // The raw token appears nowhere in the table.
    const rows = await env.sql`SELECT t::text AS txt FROM team_invites t WHERE business_id = ${b.id}`;
    expect(JSON.stringify(rows)).not.toContain(r.token);
    const listed = await listInvites(env.sql, b.id, b.owner);
    expect(JSON.stringify(listed)).not.toContain(r.token);
  });
  it("defaults to a 7 day expiry and one use", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "viewer" });
    if (!r.ok) throw new Error();
    const days = (new Date(r.invite.expiresAt).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    expect(r.invite.maxUses).toBe(1);
  });
  it("accepting adds the membership with the invited role and consumes the use", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "viewer" });
    if (!r.ok) throw new Error();
    const u = user();
    const a = await acceptInvite(env.sql, { token: r.token, user: u, seatLimit: null });
    expect(a).toMatchObject({ ok: true, businessId: b.id, role: "viewer", inviteId: r.invite.id, invitedBy: b.owner, usesLeft: 0 });
    expect(await roleOf(b.id, u.id)).toBe("viewer");
    expect((await listMembers(env.sql, b.id)).find((m) => m.userId === u.id)?.email).toBe(u.email);
    // Single use: another user cannot reuse it.
    expect(await acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: null })).toMatchObject({ ok: false, problem: "exhausted" });
  });
  it("rejects unknown and malformed tokens", async () => {
    expect(await acceptInvite(env.sql, { token: "x", user: user(), seatLimit: null })).toMatchObject({ ok: false, problem: "not_found" });
    expect(await acceptInvite(env.sql, { token: "a".repeat(43), user: user(), seatLimit: null })).toMatchObject({ ok: false, problem: "not_found" });
    expect(await previewInvite(env.sql, "a".repeat(43))).toMatchObject({ ok: false, problem: "not_found" });
  });
  it("rejects an expired invite", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member" });
    if (!r.ok) throw new Error();
    await env.sql`UPDATE team_invites SET expires_at = now() - interval '1 minute' WHERE id = ${r.invite.id}`;
    expect(await previewInvite(env.sql, r.token)).toMatchObject({ ok: false, problem: "expired" });
    expect(await acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: null })).toMatchObject({ ok: false, problem: "expired" });
  });
  it("revoke blocks acceptance; only members with permission can revoke, scoped to the business", async () => {
    const b = await biz();
    const other = await biz("Other Co");
    const m = await b.add("member");
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member" });
    if (!r.ok) throw new Error();
    expect(await revokeInvite(env.sql, { businessId: b.id, actorId: m, inviteId: r.invite.id })).toMatchObject({ ok: false, code: "forbidden" });
    // The other business's owner cannot revoke it by id, in either business context.
    expect(await revokeInvite(env.sql, { businessId: other.id, actorId: other.owner, inviteId: r.invite.id })).toMatchObject({ ok: false, code: "not_found" });
    expect(await revokeInvite(env.sql, { businessId: b.id, actorId: other.owner, inviteId: r.invite.id })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await revokeInvite(env.sql, { businessId: b.id, actorId: b.owner, inviteId: r.invite.id })).toMatchObject({ ok: true });
    expect(await acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: null })).toMatchObject({ ok: false, problem: "revoked" });
  });
  it("email restriction: only the invited address (case-insensitive) may accept", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member", email: "  Jane@Example.com " });
    if (!r.ok) throw new Error();
    expect(r.invite.email).toBe("jane@example.com");
    expect(await acceptInvite(env.sql, { token: r.token, user: user(undefined, "mallory@example.com"), seatLimit: null })).toMatchObject({ ok: false, problem: "email_mismatch" });
    expect(await previewInvite(env.sql, r.token, { id: "x", email: "mallory@example.com" })).toMatchObject({ ok: false, problem: "email_mismatch" });
    const jane = user(undefined, "JANE@example.com");
    expect(await acceptInvite(env.sql, { token: r.token, user: jane, seatLimit: null })).toMatchObject({ ok: true });
  });
  it("max uses: a multi-use invite works until used up", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member", maxUses: 2 });
    if (!r.ok) throw new Error();
    expect(await acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: null })).toMatchObject({ ok: true, usesLeft: 1 });
    expect(await acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: null })).toMatchObject({ ok: true, usesLeft: 0 });
    expect(await acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: null })).toMatchObject({ ok: false, problem: "exhausted" });
  });
  it("an existing member cannot accept again", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "admin" });
    if (!r.ok) throw new Error();
    const res = await acceptInvite(env.sql, { token: r.token, user: { id: b.owner, email: "o@example.com" }, seatLimit: null });
    expect(res).toMatchObject({ ok: false, problem: "already_member", businessId: b.id });
    expect(await roleOf(b.id, b.owner)).toBe("owner");
    const [{ use_count }] = await env.sql<{ use_count: number }[]>`SELECT use_count FROM team_invites WHERE id = ${r.invite.id}`;
    expect(use_count).toBe(0);
  });
  it("concurrent double accept of a single-use invite admits exactly one", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member" });
    if (!r.ok) throw new Error();
    const results = await Promise.all(Array.from({ length: 6 }, () => acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: null })));
    expect(results.filter((x) => x.ok).length).toBe(1);
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int n FROM business_members WHERE business_id = ${b.id}`;
    expect(n).toBe(2);
    const [{ use_count }] = await env.sql<{ use_count: number }[]>`SELECT use_count FROM team_invites WHERE id = ${r.invite.id}`;
    expect(use_count).toBe(1);
  });
  it("the same user accepting twice concurrently joins once", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member", maxUses: 5 });
    if (!r.ok) throw new Error();
    const u = user();
    const results = await Promise.all([1, 2, 3].map(() => acceptInvite(env.sql, { token: r.token, user: u, seatLimit: null })));
    expect(results.filter((x) => x.ok).length).toBe(1);
  });
  it("owners cannot be invited; admins cannot invite admins", async () => {
    const b = await biz();
    const admin = await b.add("admin");
    expect(await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "owner" })).toMatchObject({ ok: false, code: "owner_protected" });
    expect(await createInvite(env.sql, { businessId: b.id, actorId: admin, role: "admin" })).toMatchObject({ ok: false });
    expect(await createInvite(env.sql, { businessId: b.id, actorId: admin, role: "member" })).toMatchObject({ ok: true });
    expect(await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "nonsense" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member", email: "not-an-email" })).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("seat limit", () => {
  it("blocks acceptance at the limit and allows it below", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member", maxUses: 5 });
    if (!r.ok) throw new Error();
    // 1 member now; limit 2 admits one more.
    expect(await acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: 2 })).toMatchObject({ ok: true });
    expect(await acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: 2 })).toMatchObject({ ok: false, problem: "seat_limit" });
    expect(await seatUsage(env.sql, b.id, 2)).toEqual({ used: 2, limit: 2, full: true });
    // The failed attempt did not consume a use; raising the limit lets it through.
    expect(await acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: 3 })).toMatchObject({ ok: true });
    expect(await seatUsage(env.sql, b.id, null)).toEqual({ used: 3, limit: null, full: false });
  });
  it("concurrent accepts cannot exceed the seat limit", async () => {
    const b = await biz();
    const r = await createInvite(env.sql, { businessId: b.id, actorId: b.owner, role: "member", maxUses: 10 });
    if (!r.ok) throw new Error();
    const results = await Promise.all(Array.from({ length: 6 }, () => acceptInvite(env.sql, { token: r.token, user: user(), seatLimit: 3 })));
    expect(results.filter((x) => x.ok).length).toBe(2);
    expect((await seatUsage(env.sql, b.id, 3)).used).toBe(3);
  });
});

describe("tenant isolation", () => {
  it("cannot act on another business's members", async () => {
    const a = await biz("A");
    const b = await biz("B");
    const victim = await b.add("member");
    // A's owner targets B's member while operating in A's business: the target is not a member there.
    expect(await changeRole(env.sql, { businessId: a.id, actorId: a.owner, targetUserId: victim, newRole: "viewer" })).toMatchObject({ ok: false, code: "not_member" });
    expect(await removeMember(env.sql, { businessId: a.id, actorId: a.owner, targetUserId: victim })).toMatchObject({ ok: false, code: "not_member" });
    expect(await transferOwnership(env.sql, { businessId: a.id, actorId: a.owner, targetUserId: victim })).toMatchObject({ ok: false, code: "not_member" });
    expect(await roleOf(b.id, victim)).toBe("member");
    // A's owner is not an actor inside B.
    expect(await changeRole(env.sql, { businessId: b.id, actorId: a.owner, targetUserId: victim, newRole: "viewer" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await removeMember(env.sql, { businessId: b.id, actorId: a.owner, targetUserId: victim })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await createInvite(env.sql, { businessId: b.id, actorId: a.owner, role: "member" })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await listInvites(env.sql, b.id, a.owner)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await listMembers(env.sql, a.id)).toHaveLength(1);
  });
  it("active business: cookie is honored only for memberships", async () => {
    const a = await biz("Active A");
    const b = await biz("Active B");
    const multi = uid();
    await env.sql`INSERT INTO business_members (business_id, user_id, role) VALUES (${a.id}, ${multi}, 'member'), (${b.id}, ${multi}, 'viewer')`;
    expect(await resolveActiveBusinessId(env.sql, multi, b.id)).toBe(b.id);
    expect(await resolveActiveBusinessId(env.sql, multi, a.id)).toBe(a.id);
    // Not a member of another business: falls back to the user's own.
    const outsider = await biz("Not mine");
    expect(await resolveActiveBusinessId(env.sql, multi, outsider.id)).toBe(a.id);
    expect(await resolveActiveBusinessId(env.sql, multi, "garbage")).toBe(a.id);
    expect(await resolveActiveBusinessId(env.sql, multi, undefined)).toBe(a.id);
    expect(await resolveActiveBusinessId(env.sql, "nobody-" + uid(), a.id)).toBeNull();
  });
});
