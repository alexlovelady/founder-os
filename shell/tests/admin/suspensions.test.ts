import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { countActiveSuspensions, isSuspended, liftSuspension, listSuspensions, listUsers, suspendUser, validateReason } from "@/lib/admin/suspensions";

let env: TestEnv;
const U1 = "admtest-user-1";
const U2 = "admtest-user-2";
const ADMIN = "admtest-admin";

beforeAll(async () => {
  env = await makeTestEnv([]);
  await env.sql`DELETE FROM platform_suspensions WHERE user_id LIKE 'admtest-%'`;
});
afterAll(async () => {
  await env.sql`DELETE FROM platform_suspensions WHERE user_id LIKE 'admtest-%'`;
  await env.sql`DELETE FROM team_member_profiles WHERE user_id LIKE 'admtest-%'`;
  await env.sql`DELETE FROM business_members WHERE user_id LIKE 'admtest-%'`;
  await env.cleanup();
});

describe("suspension lifecycle", () => {
  it("is not suspended by default, including for unknown or empty ids", async () => {
    expect(await isSuspended(env.sql, U1)).toBe(false);
    expect(await isSuspended(env.sql, "")).toBe(false);
  });

  it("suspends, reports suspended, rejects a duplicate, lifts, and can suspend again", async () => {
    expect(await suspendUser(env.sql, { userId: U1, reason: "  abuse  ", suspendedBy: ADMIN })).toEqual({ ok: true });
    expect(await isSuspended(env.sql, U1)).toBe(true);
    expect(await isSuspended(env.sql, U2)).toBe(false);
    const [row] = (await listSuspensions(env.sql, { activeOnly: true })).filter((s) => s.userId === U1);
    expect(row).toMatchObject({ reason: "abuse", suspendedBy: ADMIN, liftedAt: null });

    expect(await suspendUser(env.sql, { userId: U1, reason: "again", suspendedBy: ADMIN })).toMatchObject({ ok: false, status: 409 });

    expect(await liftSuspension(env.sql, U1)).toBe(true);
    expect(await isSuspended(env.sql, U1)).toBe(false);
    expect(await liftSuspension(env.sql, U1)).toBe(false); // nothing left to lift
    const all = (await listSuspensions(env.sql)).find((s) => s.userId === U1);
    expect(all?.liftedAt).not.toBeNull();
    expect((await listSuspensions(env.sql, { activeOnly: true })).some((s) => s.userId === U1)).toBe(false);

    expect(await suspendUser(env.sql, { userId: U1, reason: "second offence", suspendedBy: ADMIN })).toEqual({ ok: true });
    expect(await isSuspended(env.sql, U1)).toBe(true);
    expect((await listSuspensions(env.sql)).find((s) => s.userId === U1)).toMatchObject({ reason: "second offence", liftedAt: null });
    await liftSuspension(env.sql, U1);
  });

  it("requires a reason and refuses self-suspension", async () => {
    expect(await suspendUser(env.sql, { userId: U2, reason: "   ", suspendedBy: ADMIN })).toMatchObject({ ok: false, status: 400 });
    expect(await suspendUser(env.sql, { userId: U2, reason: "x".repeat(501), suspendedBy: ADMIN })).toMatchObject({ ok: false, status: 400 });
    expect(await suspendUser(env.sql, { userId: ADMIN, reason: "oops", suspendedBy: ADMIN })).toMatchObject({ ok: false, status: 400, error: "You cannot suspend your own account" });
    expect(await suspendUser(env.sql, { userId: "", reason: "r", suspendedBy: ADMIN })).toMatchObject({ ok: false, status: 400 });
    expect(await isSuspended(env.sql, ADMIN)).toBe(false);
    expect(await isSuspended(env.sql, U2)).toBe(false);
  });

  it("validateReason trims and bounds", () => {
    expect(validateReason(" ok ")).toEqual({ ok: true, reason: "ok" });
    expect(validateReason(undefined).ok).toBe(false);
    expect(validateReason(42).ok).toBe(false);
  });

  it("counts active suspensions", async () => {
    const before = await countActiveSuspensions(env.sql);
    await suspendUser(env.sql, { userId: U2, reason: "count", suspendedBy: ADMIN });
    expect(await countActiveSuspensions(env.sql)).toBe(before + 1);
    await liftSuspension(env.sql, U2);
    expect(await countActiveSuspensions(env.sql)).toBe(before);
  });
});

describe("listUsers", () => {
  it("joins memberships with profiles, counts businesses, flags suspended users, searches", async () => {
    const [b1] = await env.sql<{ id: string }[]>`INSERT INTO businesses (name) VALUES ('Users Co 1') RETURNING id`;
    const [b2] = await env.sql<{ id: string }[]>`INSERT INTO businesses (name) VALUES ('Users Co 2') RETURNING id`;
    try {
      await env.sql`INSERT INTO business_members (business_id, user_id, role) VALUES (${b1.id}, ${U1}, 'owner'), (${b2.id}, ${U1}, 'member'), (${b1.id}, ${U2}, 'member')`;
      await env.sql`INSERT INTO team_member_profiles (business_id, user_id, email, display_name) VALUES (${b1.id}, ${U1}, 'one@example.test', 'User One')`;
      await suspendUser(env.sql, { userId: U2, reason: "list", suspendedBy: ADMIN });
      await suspendUser(env.sql, { userId: "admtest-ghost", reason: "no membership", suspendedBy: ADMIN });

      const rows = await listUsers(env.sql, { search: "admtest-" });
      const u1 = rows.find((r) => r.userId === U1)!;
      expect(u1).toMatchObject({ businesses: 2, email: "one@example.test", displayName: "User One", suspended: false });
      expect(u1.lastSeenAt).not.toBeNull();
      expect(rows.find((r) => r.userId === U2)).toMatchObject({ businesses: 1, suspended: true, suspendedReason: "list", email: null });
      expect(rows.find((r) => r.userId === "admtest-ghost")).toMatchObject({ businesses: 0, suspended: true });
      expect(rows[0].suspended).toBe(true); // suspended users first

      expect((await listUsers(env.sql, { search: "one@example" })).map((r) => r.userId)).toEqual([U1]);
      expect((await listUsers(env.sql, { search: "100%_" })).length).toBe(0); // wildcards are escaped
    } finally {
      await env.sql`DELETE FROM businesses WHERE id IN (${b1.id}, ${b2.id})`;
    }
  });
});
