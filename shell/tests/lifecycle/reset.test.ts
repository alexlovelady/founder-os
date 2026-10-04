import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { hashIp } from "@/lib/lifecycle/limits";
import { FORGOT_GENERIC, RESET_NOT_AVAILABLE, completeReset, createAdminResetLink, requestPasswordReset, resetTokenValid } from "@/lib/lifecycle/reset";
import { hashToken, plausibleToken } from "@/lib/lifecycle/tokens";
import { ENV, ENV_NO_EMAIL, fakeLegal, lastLinkToken, noFlush, rnd } from "./helpers";

let env: TestEnv;
const emails: string[] = [];
const ips: string[] = [];
beforeAll(async () => { env = await makeTestEnv([]); });
afterAll(async () => {
  if (emails.length) await env.sql`DELETE FROM email_outbox WHERE to_email IN ${env.sql(emails)}`;
  if (ips.length) await env.sql`DELETE FROM lifecycle_attempts WHERE ip_hash IN ${env.sql(ips)}`;
  await env.cleanup();
});

const ipFor = () => { const ip = `198.51.100.${Math.floor(Math.random() * 250)}-${rnd()}`; ips.push(hashIp(ip, ENV())); return ip; };
const newEmail = () => { const e = `${rnd()}@example.com`; emails.push(e); return e; };
const NEWPW = "a brand new passphrase";

async function setup(opts: { known?: boolean } = {}) {
  const legal = fakeLegal();
  const email = newEmail();
  const user = opts.known === false ? null : legal.add(email);
  const deps = (ip = ipFor(), extra: Record<string, string> = {}) => ({ fetch: legal.f, env: ENV(extra), ip, flush: noFlush });
  return { legal, email, user, deps };
}

describe("requestPasswordReset", () => {
  it("known address: stores only the token hash, queues one email with the link, 30 minute expiry", async () => {
    const { legal, email, user, deps } = await setup();
    const r = await requestPasswordReset(env.sql, { email: email.toUpperCase() }, deps());
    expect(r).toEqual({ ok: true, available: true, message: FORGOT_GENERIC });
    const token = await lastLinkToken(env.sql, email, "reset");
    expect(token).toBeTruthy();
    expect(plausibleToken(token)).toBe(true);
    const rows = await env.sql<{ user_id: string; token_hash: string; created_by: string; expires_at: Date; used_at: Date | null }[]>`SELECT * FROM password_reset_tokens WHERE user_id = ${user!.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(createHash("sha256").update(token!).digest("hex"));
    expect(rows[0].created_by).toBe("self");
    expect(JSON.stringify(rows)).not.toContain(token!);
    const mins = (rows[0].expires_at.getTime() - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(28);
    expect(mins).toBeLessThanOrEqual(30);
    const [mail] = await env.sql<{ body_text: string; business_id: string | null }[]>`SELECT body_text, business_id FROM email_outbox WHERE to_email = ${email}`;
    expect(mail.business_id).toBeNull();
    expect(mail.body_text).toContain(`https://app.example.test/reset/${token}`);
    expect(mail.body_text).not.toContain(user!.id);
    expect(legal.called(/POST \/api\/internal\/users\/lookup/)).toHaveLength(1);
  });

  it("unknown address: the SAME answer, nothing created (no account enumeration)", async () => {
    const known = await setup();
    const unknown = await setup({ known: false });
    const a = await requestPasswordReset(env.sql, { email: known.email }, known.deps());
    const b = await requestPasswordReset(env.sql, { email: unknown.email }, unknown.deps());
    expect(b).toEqual(a);
    const [n] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM email_outbox WHERE to_email = ${unknown.email}`;
    expect(n.n).toBe(0);
  });

  it("LegalAI failing gives the same generic answer too", async () => {
    const { legal, email, deps } = await setup();
    legal.fail.lookup = 500;
    expect(await requestPasswordReset(env.sql, { email }, deps())).toEqual({ ok: true, available: true, message: FORGOT_GENERIC });
  });

  it("email not configured: says so, creates nothing, does not even call LegalAI", async () => {
    const { legal, email, user } = await setup();
    const r = await requestPasswordReset(env.sql, { email }, { fetch: legal.f, env: ENV_NO_EMAIL(), ip: ipFor(), flush: noFlush });
    expect(r).toEqual({ ok: true, available: false, message: RESET_NOT_AVAILABLE });
    expect(RESET_NOT_AVAILABLE).toBe("Password reset by email is not available yet. Ask your administrator for a reset link.");
    expect(legal.calls).toHaveLength(0);
    expect(await env.sql`SELECT 1 FROM password_reset_tokens WHERE user_id = ${user!.id}`).toHaveLength(0);
    expect(await env.sql`SELECT 1 FROM email_outbox WHERE to_email = ${email}`).toHaveLength(0);
    // provider set but no APP_URL: links could not be absolute, so it is also "not configured"
    const noUrl = await requestPasswordReset(env.sql, { email }, { fetch: legal.f, env: ENV({ APP_URL: "" }), ip: ipFor(), flush: noFlush });
    expect(noUrl).toMatchObject({ available: false });
  });

  it("malformed address is a 400", async () => {
    const { deps } = await setup();
    expect(await requestPasswordReset(env.sql, { email: "nope" }, deps())).toMatchObject({ ok: false, status: 400 });
    expect(await requestPasswordReset(env.sql, null, deps())).toMatchObject({ ok: false, status: 400 });
  });

  it("per-email limit (3/hour) is silent: same answer, no 4th mail", async () => {
    const { email, deps } = await setup();
    const out = [];
    for (let i = 0; i < 5; i++) out.push(await requestPasswordReset(env.sql, { email }, deps()));
    expect(new Set(out.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(await env.sql`SELECT 1 FROM email_outbox WHERE to_email = ${email}`).toHaveLength(3);
  });

  it("per-IP limit (5/hour) answers 429, whatever the address", async () => {
    const { deps } = await setup();
    const ip = ipFor();
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const r = await requestPasswordReset(env.sql, { email: newEmail() }, deps(ip));
      codes.push(r.ok ? 200 : r.status);
    }
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("stores only keyed hashes of the ip and email in the attempt log", async () => {
    const { email, deps } = await setup();
    const ip = ipFor();
    await requestPasswordReset(env.sql, { email }, deps(ip));
    const rows = await env.sql`SELECT * FROM lifecycle_attempts WHERE ip_hash = ${hashIp(ip, ENV())}`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(email);
    expect(JSON.stringify(rows)).not.toContain(ip);
  });
});

describe("completeReset", () => {
  async function liveToken() {
    const s = await setup();
    await requestPasswordReset(env.sql, { email: s.email }, s.deps());
    const token = (await lastLinkToken(env.sql, s.email, "reset"))!;
    return { ...s, token };
  }

  it("sets the password through LegalAI, then the token cannot be used again", async () => {
    const { legal, user, token, deps } = await liveToken();
    expect(await resetTokenValid(env.sql, token)).toBe(true);
    const r = await completeReset(env.sql, { token, password: NEWPW }, deps());
    expect(r).toEqual({ ok: true, next: "/login?reset=1" });
    expect(user!.password).toBe(NEWPW);
    const call = legal.called(/POST \/api\/internal\/users\/.*\/password/)[0];
    expect(call.path).toBe(`/api/internal/users/${user!.id}/password`);
    expect(call.token).toBeTruthy();
    expect(await resetTokenValid(env.sql, token)).toBe(false);
    const again = await completeReset(env.sql, { token, password: "another new passphrase" }, deps());
    expect(again).toMatchObject({ ok: false, status: 400 });
    expect(legal.called(/\/password/)).toHaveLength(1);
    expect(user!.password).toBe(NEWPW);
  });

  it("single use under concurrency: exactly one of many parallel requests wins", async () => {
    const { legal, token, deps } = await liveToken();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => completeReset(env.sql, { token, password: `parallel passphrase ${i}` }, deps())));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(legal.called(/\/password/)).toHaveLength(1);
  });

  it("expired and unknown tokens are refused without calling LegalAI", async () => {
    const { legal, token, deps } = await liveToken();
    await env.sql`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE token_hash = ${hashToken(token)}`;
    expect(await resetTokenValid(env.sql, token)).toBe(false);
    expect(await completeReset(env.sql, { token, password: NEWPW }, deps())).toMatchObject({ ok: false, status: 400 });
    expect(await completeReset(env.sql, { token: "A".repeat(43), password: NEWPW }, deps())).toMatchObject({ ok: false, status: 400 });
    expect(await completeReset(env.sql, { token: "short", password: NEWPW }, deps())).toMatchObject({ ok: false, status: 400 });
    expect(legal.calls.filter((c) => /password$/.test(c.path))).toHaveLength(0);
  });

  it("a rejected (too short or weak) password does not burn the link", async () => {
    const { user, token, deps } = await liveToken();
    expect(await completeReset(env.sql, { token, password: "short" }, deps())).toMatchObject({ ok: false, status: 400 });
    expect(await completeReset(env.sql, { token, password: "aaaaaaaaaaaaaaaa" }, deps())).toMatchObject({ ok: false, status: 400 });
    expect(await resetTokenValid(env.sql, token)).toBe(true);
    expect((await completeReset(env.sql, { token, password: NEWPW }, deps())).ok).toBe(true);
    expect(user!.password).toBe(NEWPW);
  });

  it("when LegalAI fails the link is given back; when it rejects the password the link is kept", async () => {
    const { legal, user, token, deps } = await liveToken();
    legal.fail.password = 500;
    expect(await completeReset(env.sql, { token, password: NEWPW }, deps())).toMatchObject({ ok: false, status: 503 });
    expect(await resetTokenValid(env.sql, token)).toBe(true);
    legal.fail.password = 422;
    expect(await completeReset(env.sql, { token, password: NEWPW }, deps())).toMatchObject({ ok: false, status: 400 });
    expect(await resetTokenValid(env.sql, token)).toBe(true);
    delete legal.fail.password;
    expect((await completeReset(env.sql, { token, password: NEWPW }, deps())).ok).toBe(true);
    expect(user!.password).toBe(NEWPW);
  });

  it("an account that no longer exists leaves the link spent", async () => {
    const { legal, user, token, deps } = await liveToken();
    legal.users.delete(user!.id);
    expect(await completeReset(env.sql, { token, password: NEWPW }, deps())).toMatchObject({ ok: false, status: 400 });
    expect(await resetTokenValid(env.sql, token)).toBe(false);
  });

  it("using one link revokes the other outstanding links for that user", async () => {
    const s = await liveToken();
    const second = await createAdminResetLink(env.sql, { adminId: "admin-1", targetUserId: s.user!.id });
    if (!second.ok) throw new Error("setup");
    const adminToken = second.path.replace("/reset/", "");
    expect(await resetTokenValid(env.sql, adminToken)).toBe(true);
    expect((await completeReset(env.sql, { token: s.token, password: NEWPW }, s.deps())).ok).toBe(true);
    expect(await resetTokenValid(env.sql, adminToken)).toBe(false);
    expect(await completeReset(env.sql, { token: adminToken, password: "yet another passphrase" }, s.deps())).toMatchObject({ ok: false });
  });

  it("never writes the token or password to the audit log or the attempt log", async () => {
    const { user, token, deps } = await liveToken();
    await completeReset(env.sql, { token, password: NEWPW }, deps());
    const audit = await env.sql`SELECT * FROM audit_events WHERE user_id = ${user!.id}`;
    expect(audit.map((a) => a.action)).toContain("account.password_reset");
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(NEWPW);
  });

  it("limits attempts per IP (20/hour)", async () => {
    const { deps } = await setup();
    const ip = ipFor();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const r = await completeReset(env.sql, { token: "B".repeat(43), password: NEWPW }, deps(ip));
      last = r.ok ? 200 : r.status;
    }
    expect(last).toBe(429);
  });
});

describe("admin-created links", () => {
  it("24 hours, stored hashed with the admin id, shown once as a path, audited without the token, usable", async () => {
    const legal = fakeLegal();
    const user = legal.add(newEmail());
    const r = await createAdminResetLink(env.sql, { adminId: "admin-42", targetUserId: user.id });
    if (!r.ok) throw new Error("expected ok");
    expect(r.path).toMatch(/^\/reset\/[A-Za-z0-9_-]{43}$/);
    const token = r.path.slice("/reset/".length);
    const [row] = await env.sql<{ created_by: string; expires_at: Date; token_hash: string }[]>`SELECT * FROM password_reset_tokens WHERE user_id = ${user.id}`;
    expect(row.created_by).toBe("admin:admin-42");
    expect(row.token_hash).toBe(hashToken(token));
    const hours = (row.expires_at.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    const audit = await env.sql<{ meta: unknown; user_id: string; action: string }[]>`SELECT * FROM audit_events WHERE action = 'admin.user.reset_link_created' AND resource_id = ${user.id}`;
    expect(audit).toHaveLength(1);
    expect(audit[0].user_id).toBe("admin-42");
    expect(JSON.stringify(audit)).not.toContain(token);
    const done = await completeReset(env.sql, { token, password: NEWPW }, { fetch: legal.f, env: ENV(), ip: ipFor(), flush: noFlush });
    expect(done.ok).toBe(true);
    expect(user.password).toBe(NEWPW);
  });

  it("rejects ids that are not user ids", async () => {
    expect(await createAdminResetLink(env.sql, { adminId: "a", targetUserId: "../../x" })).toMatchObject({ ok: false, status: 400 });
  });
});
