import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { deleteAccount } from "@/lib/lifecycle/deletion";
import { hashIp } from "@/lib/lifecycle/limits";
import { ENV, fakeLegal, noFlush, rnd } from "./helpers";

let env: TestEnv;
const businesses: string[] = [];
const ips: string[] = [];
beforeAll(async () => { env = await makeTestEnv([]); });
afterAll(async () => {
  if (businesses.length) await env.sql`DELETE FROM businesses WHERE id IN ${env.sql(businesses)}`;
  if (ips.length) await env.sql`DELETE FROM lifecycle_attempts WHERE ip_hash IN ${env.sql(ips)}`;
  await env.cleanup();
});

const PW = "current password 123";
const ipFor = () => { const ip = `203.0.113.${Math.floor(Math.random() * 250)}-${rnd()}`; ips.push(hashIp(ip, ENV())); return ip; };

async function biz(name: string, members: [string, string][]): Promise<string> {
  const [b] = await env.sql<{ id: string }[]>`INSERT INTO businesses (name) VALUES (${name}) RETURNING id`;
  businesses.push(b.id);
  for (const [uid, role] of members) await env.sql`INSERT INTO business_members (business_id, user_id, role) VALUES (${b.id}, ${uid}, ${role})`;
  return b.id;
}
const exists = async (id: string) => (await env.sql`SELECT 1 FROM businesses WHERE id = ${id}`).length === 1;
const member = async (b: string, u: string) => (await env.sql`SELECT 1 FROM business_members WHERE business_id = ${b} AND user_id = ${u}`).length === 1;

async function setup() {
  const legal = fakeLegal();
  const email = `${rnd()}@example.com`;
  const user = legal.add(email, { password: PW });
  const ip = ipFor();
  const run = (input: Record<string, unknown> = {}) => deleteAccount(env.sql, { id: user.id, email }, { confirmEmail: email, password: PW, ...input }, { fetch: legal.f, env: ENV(), ip, flush: noFlush });
  return { legal, email, user, run, ip };
}

describe("deleteAccount rules", () => {
  it("sole owner of a business that has other members is refused and NOTHING changes", async () => {
    const { legal, user, run } = await setup();
    const other = `u-${rnd()}`;
    const withTeam = await biz("Team Co", [[user.id, "owner"], [other, "member"]]);
    const solo = await biz("Solo Co", [[user.id, "owner"]]);
    const r = await run();
    expect(r).toMatchObject({ ok: false, status: 409, blockedBusinesses: ["Team Co"] });
    expect((r as { message: string }).message).toMatch(/transfer ownership/i);
    expect(await exists(withTeam)).toBe(true);
    expect(await exists(solo)).toBe(true); // the sole business is not deleted either: all or nothing
    expect(await member(withTeam, user.id)).toBe(true);
    expect(legal.called(/^DELETE/)).toHaveLength(0);
  });

  it("deletes a business where the person is the only member (with its rows), removes membership elsewhere, then deletes in LegalAI", async () => {
    const { legal, user, run } = await setup();
    const other = `u-${rnd()}`;
    const solo = await biz("Solo Co", [[user.id, "owner"]]);
    await env.sql`INSERT INTO privacy_settings (business_id, ai_data_use_notes) VALUES (${solo}, 'note')`;
    await env.sql`INSERT INTO audit_events (business_id, user_id, action) VALUES (${solo}, ${user.id}, 'x.y')`;
    const shared = await biz("Shared Co", [[other, "owner"], [user.id, "member"]]);
    await env.sql`INSERT INTO team_member_profiles (business_id, user_id, email, display_name) VALUES (${shared}, ${user.id}, 'x@y.z', 'N'), (${shared}, ${other}, 'o@y.z', 'O')`;
    await env.sql`INSERT INTO notification_preferences (business_id, user_id, email_address) VALUES (${shared}, ${user.id}, 'x@y.z')`;
    const co = await biz("Co-owned", [[other, "owner"], [user.id, "owner"], [`u-${rnd()}`, "member"]]);

    const r = await run();
    expect(r).toEqual({ ok: true, summary: { businessesDeleted: 1, membershipsRemoved: 2 } });
    expect(await exists(solo)).toBe(false);
    expect(await env.sql`SELECT 1 FROM privacy_settings WHERE business_id = ${solo}`).toHaveLength(0);
    expect(await env.sql`SELECT 1 FROM audit_events WHERE business_id = ${solo}`).toHaveLength(0);
    expect(await exists(shared)).toBe(true);
    expect(await member(shared, user.id)).toBe(false);
    expect(await member(shared, other)).toBe(true);
    expect(await exists(co)).toBe(true);
    expect(await member(co, user.id)).toBe(false);
    expect(await env.sql`SELECT 1 FROM team_member_profiles WHERE user_id = ${user.id}`).toHaveLength(0);
    expect(await env.sql`SELECT 1 FROM team_member_profiles WHERE user_id = ${other}`).toHaveLength(1);
    expect(await env.sql`SELECT 1 FROM notification_preferences WHERE user_id = ${user.id}`).toHaveLength(0);
    expect(legal.called(/^DELETE \/api\/internal\/users\//)).toHaveLength(1);
    expect(legal.users.has(user.id)).toBe(false);
    // the audit trail keeps the event with only the pseudonymous id, and the deletion of the business is recorded without its name
    const audit = await env.sql<{ action: string; meta: Record<string, unknown> }[]>`SELECT action, meta FROM audit_events WHERE user_id = ${user.id} AND action LIKE 'account.%'`;
    expect(audit.map((a) => a.action).sort()).toEqual(["account.business.delete", "account.deleted"]);
    expect(JSON.stringify(audit)).not.toContain("Solo Co");
  });

  it("a person with no business can still delete the account", async () => {
    const { legal, user, run } = await setup();
    expect(await run()).toMatchObject({ ok: true, summary: { businessesDeleted: 0, membershipsRemoved: 0 } });
    expect(legal.users.has(user.id)).toBe(false);
  });

  it("an owner with another owner may leave; the business stays", async () => {
    const { user, run } = await setup();
    const b = await biz("Two Owners", [[user.id, "owner"], [`u-${rnd()}`, "owner"], [`u-${rnd()}`, "viewer"]]);
    expect((await run()).ok).toBe(true);
    expect(await exists(b)).toBe(true);
    expect(await member(b, user.id)).toBe(false);
  });
});

describe("deleteAccount safeguards", () => {
  it("typed email must match; wrong password is refused; nothing is touched", async () => {
    const { legal, user, run } = await setup();
    const solo = await biz("Keep Me", [[user.id, "owner"]]);
    expect(await run({ confirmEmail: "someone@else.com" })).toMatchObject({ ok: false, status: 400 });
    expect(await run({ confirmEmail: "" })).toMatchObject({ ok: false, status: 400 });
    expect(await run({ password: "" })).toMatchObject({ ok: false, status: 400 });
    expect(legal.calls).toHaveLength(0); // validation happens before any call
    expect(await run({ password: "wrong password!!" })).toMatchObject({ ok: false, status: 403 });
    expect(await exists(solo)).toBe(true);
    expect(legal.called(/^DELETE/)).toHaveLength(0);
    // the typed email is compared case-insensitively
    const upper = await run({ confirmEmail: user.email.toUpperCase() });
    expect(upper.ok).toBe(true);
  });

  it("email comparison uses the session email, and the password goes only to the verify endpoint", async () => {
    const { legal, user, run } = await setup();
    await run();
    const verify = legal.called(/verify-password/)[0];
    expect(verify.body).toEqual({ password: PW });
    expect(verify.token).toBeTruthy();
    expect(legal.calls.filter((c) => !/verify-password/.test(c.path)).every((c) => c.body === null || !JSON.stringify(c.body).includes(PW))).toBe(true);
    expect(user.id).toBeTruthy();
  });

  it("refuses when LegalAI says this is the last administrator (before touching anything)", async () => {
    const { legal, user, run } = await setup();
    user.lastAdmin = true;
    const solo = await biz("Admin Co", [[user.id, "owner"]]);
    expect(await run()).toMatchObject({ ok: false, status: 409 });
    expect(await exists(solo)).toBe(true);
    expect(legal.called(/^DELETE/)).toHaveLength(0);
  });

  it("password check unavailable: 503, nothing touched", async () => {
    const { legal, user, run } = await setup();
    legal.fail.verify = 500;
    const solo = await biz("Keep", [[user.id, "owner"]]);
    expect(await run()).toMatchObject({ ok: false, status: 503 });
    expect(await exists(solo)).toBe(true);
  });

  it("if LegalAI deletion fails after the shell cleanup, the person can repeat and finish", async () => {
    const { legal, user, run } = await setup();
    const solo = await biz("Gone", [[user.id, "owner"]]);
    legal.fail.delete = 500;
    const r = await run();
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(await exists(solo)).toBe(false);
    expect(legal.users.has(user.id)).toBe(true);
    delete legal.fail.delete;
    expect(await run()).toMatchObject({ ok: true, summary: { businessesDeleted: 0, membershipsRemoved: 0 } });
    expect(legal.users.has(user.id)).toBe(false);
  });

  it("removes personal shell rows: queued/sent mail to the address, suspension, feedback, tokens; keeps the audit trail", async () => {
    const { user, email, run } = await setup();
    const other = await biz("Other Co", [[`u-${rnd()}`, "owner"], [user.id, "member"]]);
    await env.sql`INSERT INTO email_outbox (business_id, to_email, subject, body_text, body_html, status) VALUES (NULL, ${email}, 's', 't', 'h', 'sent'), (${other}, ${email}, 's2', 't', 'h', 'queued')`;
    await env.sql`INSERT INTO platform_suspensions (user_id, reason, suspended_by) VALUES (${user.id}, 'r', 'a')`;
    await env.sql`INSERT INTO feedback (business_id, user_id, kind, message) VALUES (${other}, ${user.id}, 'bug', 'hello')`;
    await env.sql`INSERT INTO password_reset_tokens (user_id, token_hash, created_by, expires_at) VALUES (${user.id}, ${randomUUID()}, 'self', now() + interval '1 hour')`;
    await env.sql`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (${user.id}, ${randomUUID()}, now() + interval '1 hour')`;
    await env.sql`INSERT INTO audit_events (business_id, user_id, action) VALUES (${other}, ${user.id}, 'tool.did.something')`;
    expect((await run()).ok).toBe(true);
    for (const q of [
      env.sql`SELECT 1 FROM email_outbox WHERE to_email = ${email}`,
      env.sql`SELECT 1 FROM platform_suspensions WHERE user_id = ${user.id}`,
      env.sql`SELECT 1 FROM feedback WHERE user_id = ${user.id}`,
      env.sql`SELECT 1 FROM password_reset_tokens WHERE user_id = ${user.id}`,
      env.sql`SELECT 1 FROM email_verifications WHERE user_id = ${user.id}`,
    ]) expect(await q).toHaveLength(0);
    expect(await env.sql`SELECT 1 FROM audit_events WHERE user_id = ${user.id} AND action = 'tool.did.something'`).toHaveLength(1);
  });

  it("limits attempts per account (5/hour)", async () => {
    const { run } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await run({ password: "definitely wrong" });
      codes.push(r.ok ? 200 : r.status);
    }
    expect(codes).toEqual([403, 403, 403, 403, 403, 429]);
  });
});
