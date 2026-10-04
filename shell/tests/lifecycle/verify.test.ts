import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { hashIp } from "@/lib/lifecycle/limits";
import { OPEN_NEEDS_EMAIL, signup } from "@/lib/signup/service";
import { RESEND_GENERIC, VERIFY_NOT_AVAILABLE, confirmVerification, purgeUnverified, resendVerification, verifyTokenValid } from "@/lib/lifecycle/verify";
import { hashToken } from "@/lib/lifecycle/tokens";
import { ENV, ENV_NO_EMAIL, fakeLegal, lastLinkToken, noFlush, rnd, TOKEN } from "./helpers";

let env: TestEnv;
const emails: string[] = [];
const ips: string[] = [];
const userIds: string[] = [];
beforeAll(async () => { env = await makeTestEnv([]); });
afterAll(async () => {
  if (emails.length) await env.sql`DELETE FROM email_outbox WHERE to_email IN ${env.sql(emails)}`;
  if (ips.length) await env.sql`DELETE FROM lifecycle_attempts WHERE ip_hash IN ${env.sql(ips)}`;
  if (userIds.length) await env.sql`DELETE FROM email_verifications WHERE user_id IN ${env.sql(userIds)}`;
  await env.cleanup();
});

const ipFor = () => { const ip = `192.0.2.${Math.floor(Math.random() * 250)}-${rnd()}`; ips.push(hashIp(ip, ENV())); return ip; };
const newEmail = () => { const e = `${rnd()}@example.com`; emails.push(e); return e; };
const OPEN = (extra: Record<string, string> = {}) => ({ ...ENV(), SIGNUP_MODE: "open", ...extra });
const form = (email: string) => ({ email, password: "a long enough passphrase", displayName: "Pat Test", acceptTerms: true });

/** Fake LegalAI whose create endpoint makes inactive/active users, like the real one. */
function legalWithCreate() {
  const legal = fakeLegal();
  const inner = legal.f;
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.pathname === "/api/internal/users" && init.method === "POST") {
      const body = JSON.parse(init.body as string) as { email: string; active?: boolean };
      legal.calls.push({ method: "POST", path: u.pathname, body: body as never, token: (init.headers as Record<string, string>)["x-internal-token"] });
      const user = legal.add(body.email, { active: body.active !== false });
      userIds.push(user.id);
      return new Response(JSON.stringify({ id: user.id }), { status: 200 });
    }
    return inner(url, init);
  }) as unknown as typeof fetch;
  return { ...legal, f };
}

describe("open signup requires verification", () => {
  it("refuses to accept signups when email is not configured (never runs unverified)", async () => {
    const legal = legalWithCreate();
    const r = await signup(form(newEmail()), { sql: env.sql, fetch: legal.f, env: { ...ENV_NO_EMAIL(), SIGNUP_MODE: "open" }, ip: ipFor(), flush: noFlush });
    expect(r).toEqual({ ok: false, status: 503, message: OPEN_NEEDS_EMAIL });
    expect(OPEN_NEEDS_EMAIL).toBe("Open signup needs email verification, which is not configured. Ask the administrator.");
    expect(legal.calls).toHaveLength(0);
  });

  it("creates the account INACTIVE, stores a hashed token without the address, and queues the email", async () => {
    const legal = legalWithCreate();
    const email = newEmail();
    const r = await signup(form(email), { sql: env.sql, fetch: legal.f, env: OPEN(), ip: ipFor(), flush: noFlush });
    expect(r).toEqual({ ok: true, next: "/verify?sent=1" });
    const create = legal.calls.find((c) => c.path === "/api/internal/users")!;
    expect(create.body).toMatchObject({ active: false });
    const user = [...legal.users.values()].find((u) => u.email === email)!;
    expect(user.active).toBe(false);
    const token = (await lastLinkToken(env.sql, email, "verify"))!;
    expect(token).toBeTruthy();
    const rows = await env.sql<Record<string, unknown>[]>`SELECT * FROM email_verifications WHERE user_id = ${user.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(email);
    expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "expires_at", "id", "token_hash", "used_at", "user_id"]);
    const hours = ((rows[0].expires_at as Date).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    const [mail] = await env.sql<{ body_text: string; business_id: string | null }[]>`SELECT body_text, business_id FROM email_outbox WHERE to_email = ${email}`;
    expect(mail.business_id).toBeNull();
    expect(mail.body_text).toContain(`https://app.example.test/verify/${token}`);
    // the audit event carries no address
    const audit = await env.sql`SELECT * FROM audit_events WHERE user_id = ${user.id}`;
    expect(JSON.stringify(audit)).not.toContain(email);
  });

  it("invite mode is unchanged: active account, no verification, no email", async () => {
    const legal = legalWithCreate();
    const email = newEmail();
    const { createCode } = await import("@/lib/signup/codes");
    const c = await createCode(env.sql, { actorId: "admin-1", label: "t" });
    if (!c.ok) throw new Error("setup");
    const r = await signup({ ...form(email), code: c.code }, { sql: env.sql, fetch: legal.f, env: { ...ENV(), SIGNUP_MODE: "invite" }, ip: ipFor(), flush: noFlush });
    expect(r).toEqual({ ok: true, next: "/login?created=1" });
    expect(legal.calls[0].body).not.toHaveProperty("active");
    expect([...legal.users.values()][0].active).toBe(true);
    expect(await env.sql`SELECT 1 FROM email_outbox WHERE to_email = ${email}`).toHaveLength(0);
    await env.sql`DELETE FROM signup_codes WHERE id = ${c.summary.id}`;
  });

  it("closed mode is unchanged", async () => {
    const legal = legalWithCreate();
    expect(await signup(form(newEmail()), { sql: env.sql, fetch: legal.f, env: { ...ENV(), SIGNUP_MODE: "closed" }, ip: ipFor(), flush: noFlush })).toMatchObject({ ok: false, status: 403 });
    expect(legal.calls).toHaveLength(0);
  });
});

describe("confirmVerification", () => {
  async function pending() {
    const legal = legalWithCreate();
    const email = newEmail();
    await signup(form(email), { sql: env.sql, fetch: legal.f, env: OPEN(), ip: ipFor(), flush: noFlush });
    const user = [...legal.users.values()].find((u) => u.email === email)!;
    const token = (await lastLinkToken(env.sql, email, "verify"))!;
    const deps = (ip = ipFor()) => ({ fetch: legal.f, env: OPEN(), ip, flush: noFlush });
    return { legal, email, user, token, deps };
  }

  it("activates the account and sends the person to /login?verified=1; the link works once", async () => {
    const { legal, user, token, deps } = await pending();
    expect(await verifyTokenValid(env.sql, token)).toBe(true);
    expect(await confirmVerification(env.sql, token, deps())).toEqual({ ok: true, next: "/login?verified=1" });
    expect(user.active).toBe(true);
    expect(legal.called(/POST \/api\/internal\/users\/.*\/activate/)).toHaveLength(1);
    expect(await confirmVerification(env.sql, token, deps())).toMatchObject({ ok: false, status: 400 });
    expect(legal.called(/activate/)).toHaveLength(1);
  });

  it("single use under concurrency", async () => {
    const { legal, token, deps } = await pending();
    const rs = await Promise.all(Array.from({ length: 8 }, () => confirmVerification(env.sql, token, deps())));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(legal.called(/activate/)).toHaveLength(1);
  });

  it("expired, unknown and malformed tokens are refused; LegalAI failure gives the link back", async () => {
    const { legal, user, token, deps } = await pending();
    expect(await confirmVerification(env.sql, "nope", deps())).toMatchObject({ ok: false, status: 400 });
    expect(await confirmVerification(env.sql, undefined, deps())).toMatchObject({ ok: false, status: 400 });
    legal.fail.activate = 500;
    expect(await confirmVerification(env.sql, token, deps())).toMatchObject({ ok: false, status: 503 });
    expect(user.active).toBe(false);
    expect(await verifyTokenValid(env.sql, token)).toBe(true);
    delete legal.fail.activate;
    await env.sql`UPDATE email_verifications SET expires_at = now() - interval '1 minute' WHERE token_hash = ${hashToken(token)}`;
    expect(await confirmVerification(env.sql, token, deps())).toMatchObject({ ok: false, status: 400 });
    expect(user.active).toBe(false);
  });
});

describe("resendVerification", () => {
  it("generic answer; mails only an account that is still unverified and has a pending record", async () => {
    const legal = legalWithCreate();
    const pendingEmail = newEmail();
    await signup(form(pendingEmail), { sql: env.sql, fetch: legal.f, env: OPEN(), ip: ipFor(), flush: noFlush });
    const activeEmail = newEmail();
    legal.add(activeEmail);
    const suspendedEmail = newEmail();
    legal.add(suspendedEmail, { active: false }); // inactive for another reason: no verification record, so never mailed
    const deps = () => ({ fetch: legal.f, env: OPEN(), ip: ipFor(), flush: noFlush });
    const answers = [];
    for (const e of [pendingEmail, activeEmail, suspendedEmail, newEmail()]) answers.push(await resendVerification(env.sql, { email: e }, deps()));
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({ ok: true, available: true, message: RESEND_GENERIC });
    await new Promise((r) => setTimeout(r, 20));
    expect(await env.sql`SELECT 1 FROM email_outbox WHERE to_email = ${pendingEmail}`).toHaveLength(2); // original + resend
    for (const e of [activeEmail, suspendedEmail]) expect(await env.sql`SELECT 1 FROM email_outbox WHERE to_email = ${e}`).toHaveLength(0);
  });

  it("not configured: says so and does nothing; limits: per email silent, per IP 429", async () => {
    const legal = legalWithCreate();
    const email = newEmail();
    expect(await resendVerification(env.sql, { email }, { fetch: legal.f, env: ENV_NO_EMAIL(), ip: ipFor(), flush: noFlush })).toEqual({ ok: true, available: false, message: VERIFY_NOT_AVAILABLE });
    expect(legal.calls).toHaveLength(0);
    const ip = ipFor();
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const r = await resendVerification(env.sql, { email: newEmail() }, { fetch: legal.f, env: ENV(), ip, flush: noFlush });
      codes.push(r.ok ? 200 : r.status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    expect(await resendVerification(env.sql, { email: "bad" }, { fetch: legal.f, env: ENV(), ip: ipFor(), flush: noFlush })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("purgeUnverified", () => {
  async function aged(days: number, o: { used?: boolean } = {}) {
    const legal = legalWithCreate();
    const email = newEmail();
    await signup(form(email), { sql: env.sql, fetch: legal.f, env: OPEN(), ip: ipFor(), flush: noFlush });
    const user = [...legal.users.values()].find((u) => u.email === email)!;
    await env.sql`UPDATE email_verifications SET created_at = now() - make_interval(days => ${days}) ${o.used ? env.sql`, used_at = now()` : env.sql``} WHERE user_id = ${user.id}`;
    return { legal, user };
  }
  const rowsFor = (id: string) => env.sql`SELECT 1 FROM email_verifications WHERE user_id = ${id}`;

  it("deletes accounts unverified for more than 7 days (only_inactive), keeps newer and verified ones", async () => {
    const old = await aged(8);
    const young = await aged(6);
    const verified = await aged(30, { used: true });
    const run = (x: { legal: ReturnType<typeof legalWithCreate> }) => purgeUnverified(env.sql, { fetch: x.legal.f, env: ENV() });
    // the purge looks at every stale row in the shared table, so run it against the fake that owns the stale account
    const r = await run(old);
    expect(r.purged).toBeGreaterThanOrEqual(1);
    expect(old.legal.called(/DELETE \/api\/internal\/users\/.*\?only_inactive=true/)).toHaveLength(1);
    expect(old.legal.users.has(old.user.id)).toBe(false);
    expect(await rowsFor(old.user.id)).toHaveLength(0);
    expect(await rowsFor(young.user.id)).toHaveLength(1);
    expect(await rowsFor(verified.user.id)).toHaveLength(1);
    expect(young.legal.users.has(young.user.id)).toBe(true);
    const audit = await env.sql`SELECT 1 FROM audit_events WHERE action = 'account.unverified_purged' AND resource_id = ${old.user.id}`;
    expect(audit).toHaveLength(1);
  });

  it("never deletes an account that has become active (LegalAI answers 409): the rows are dropped, the account stays", async () => {
    const x = await aged(9);
    x.user.active = true;
    const r = await purgeUnverified(env.sql, { fetch: x.legal.f, env: ENV() });
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(x.legal.users.has(x.user.id)).toBe(true);
    expect(await rowsFor(x.user.id)).toHaveLength(0);
  });

  it("keeps the rows when LegalAI is unavailable so the next run retries", async () => {
    const x = await aged(9);
    x.legal.deleteStatus.set(x.user.id, 500);
    await purgeUnverified(env.sql, { fetch: x.legal.f, env: ENV() });
    expect(await rowsFor(x.user.id)).toHaveLength(1);
    x.legal.deleteStatus.clear();
    await purgeUnverified(env.sql, { fetch: x.legal.f, env: ENV() });
    expect(await rowsFor(x.user.id)).toHaveLength(0);
  });

  it("removes finished lifecycle mail but never queued mail or other mail", async () => {
    const a = newEmail();
    const b = newEmail();
    const c = newEmail();
    await env.sql`INSERT INTO email_outbox (business_id, to_email, subject, body_text, body_html, status, created_at) VALUES
      (NULL, ${a}, 'Reset your FounderOS password', 'x', 'x', 'sent', now() - interval '3 days'),
      (NULL, ${b}, 'Reset your FounderOS password', 'x', 'x', 'queued', now() - interval '3 days'),
      (NULL, ${c}, 'Something else', 'x', 'x', 'sent', now() - interval '3 days')`;
    await purgeUnverified(env.sql, { fetch: fakeLegal().f, env: ENV({ INTERNAL_PROVISION_TOKEN: TOKEN }) });
    expect(await env.sql`SELECT 1 FROM email_outbox WHERE to_email = ${a}`).toHaveLength(0);
    expect(await env.sql`SELECT 1 FROM email_outbox WHERE to_email = ${b}`).toHaveLength(1);
    expect(await env.sql`SELECT 1 FROM email_outbox WHERE to_email = ${c}`).toHaveLength(1);
  });
});
