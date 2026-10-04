import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { canonicalCode, consumeCode, createCode, hashCode, listCodes, newCode, restoreCode, revokeCode } from "@/lib/signup/codes";
import { signupMode } from "@/lib/signup/config";
import { checkAndRecordAttempt, clientIp, hashId } from "@/lib/signup/limits";
import { passwordHint, passwordProblem } from "@/lib/signup/password";
import { signup } from "@/lib/signup/service";

let env: TestEnv;
const codeIds: string[] = [];
const ipHashes: string[] = [];
beforeAll(async () => { env = await makeTestEnv([]); });
afterAll(async () => {
  if (codeIds.length) await env.sql`DELETE FROM signup_codes WHERE id IN ${env.sql(codeIds)}`;
  if (ipHashes.length) await env.sql`DELETE FROM signup_attempts WHERE ip_hash IN ${env.sql(ipHashes)}`;
  await env.sql`DELETE FROM audit_events WHERE action = 'signup.created' AND meta->>'mode' IS NOT NULL AND user_id LIKE 'fake-%'`;
  await env.cleanup();
});

const rnd = () => Math.random().toString(36).slice(2, 10);
const TOKEN = "x".repeat(40);
// Email settings are present so `open` mode (which now requires email verification) is available; nothing is ever sent (noFlush).
const E = (mode: string, extra: Record<string, string> = {}) => ({ SIGNUP_MODE: mode, INTERNAL_PROVISION_TOKEN: TOKEN, LEGAL_URL: "http://legal.test", RESEND_API_KEY: "re_test_key", EMAIL_FROM: "FounderOS <no-reply@example.test>", APP_URL: "https://app.example.test", ...extra });
const noFlush = async () => {};
const newCodeRow = async (o: { maxUses?: number; expiresInDays?: number | null } = {}) => {
  const r = await createCode(env.sql, { actorId: "admin-1", label: "t", ...o });
  if (!r.ok) throw new Error(r.message);
  codeIds.push(r.summary.id);
  return r;
};
const form = (o: Record<string, unknown> = {}) => ({ email: `${rnd()}@example.com`, password: "a long enough passphrase", displayName: "Pat Test", acceptTerms: true, ...o });
const ipFor = () => { const ip = `203.0.113.${Math.floor(Math.random() * 250)}-${rnd()}`; ipHashes.push(hashId("ip", ip, E("open"))); return ip; };

/** A fake LegalAI: records calls, answers with the given status. */
function fakeLegal(status = 200, id = `fake-${rnd()}`) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify(status === 200 ? { id } : { detail: "x" }), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls, id };
}
const useCount = async (id: string) => (await env.sql<{ use_count: number }[]>`SELECT use_count FROM signup_codes WHERE id = ${id}`)[0].use_count;

describe("codes", () => {
  it("hashes the canonical form, stores only the hash, and shows the raw code once", async () => {
    const r = await newCodeRow();
    expect(r.code).toMatch(/^FOS-[A-Z0-9]{5}(-[A-Z0-9]{5}){3}$/);
    expect(canonicalCode(r.code.toLowerCase())).toBe(canonicalCode(r.code));
    expect(hashCode(r.code)).toBe(hashCode(` ${r.code.toLowerCase().replace(/-/g, " ")} `));
    const [row] = await env.sql<{ code_hash: string }[]>`SELECT code_hash FROM signup_codes WHERE id = ${r.summary.id}`;
    expect(row.code_hash).toBe(hashCode(r.code));
    expect(JSON.stringify(row)).not.toContain(canonicalCode(r.code));
    expect(JSON.stringify(await listCodes(env.sql))).not.toContain(canonicalCode(r.code));
    expect(newCode()).not.toBe(newCode());
  });

  it("a single-use code is consumed exactly once under concurrency", async () => {
    const { code, summary } = await newCodeRow({ maxUses: 1 });
    const results = await Promise.all(Array.from({ length: 12 }, () => consumeCode(env.sql, code)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await useCount(summary.id)).toBe(1);
  });

  it("a code with N uses allows exactly N", async () => {
    const { code, summary } = await newCodeRow({ maxUses: 3 });
    const results = await Promise.all(Array.from({ length: 10 }, () => consumeCode(env.sql, code)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await useCount(summary.id)).toBe(3);
  });

  it("expired and revoked codes cannot be used; unknown codes are refused", async () => {
    const a = await newCodeRow();
    await env.sql`UPDATE signup_codes SET expires_at = now() - interval '1 minute' WHERE id = ${a.summary.id}`;
    expect(await consumeCode(env.sql, a.code)).toBeNull();
    const b = await newCodeRow();
    expect(await revokeCode(env.sql, b.summary.id)).toMatchObject({ status: "revoked" });
    expect(await consumeCode(env.sql, b.code)).toBeNull();
    expect(await consumeCode(env.sql, "FOS-AAAAA-BBBBB-CCCCC-DDDDD")).toBeNull();
    expect(await consumeCode(env.sql, "")).toBeNull();
    expect(await revokeCode(env.sql, "not-a-uuid")).toBeNull();
  });

  it("restoreCode gives a use back and never goes below zero", async () => {
    const { code, summary } = await newCodeRow({ maxUses: 1 });
    const id = (await consumeCode(env.sql, code))!;
    await restoreCode(env.sql, id);
    expect(await useCount(summary.id)).toBe(0);
    await restoreCode(env.sql, id);
    expect(await useCount(summary.id)).toBe(0);
    expect(await consumeCode(env.sql, code)).toBe(id);
  });

  it("clamps max uses and expiry", async () => {
    const r = await newCodeRow({ maxUses: 99999, expiresInDays: 99999 });
    expect(r.summary.maxUses).toBe(1000);
    expect(new Date(r.summary.expiresAt!).getTime()).toBeLessThan(Date.now() + 366 * 86400_000);
  });
});

describe("rate limiting", () => {
  it("allows 5 attempts per IP per hour, then blocks; the window slides", async () => {
    const ip = hashId("ip", ipFor());
    ipHashes.push(ip);
    for (let i = 0; i < 5; i++) expect((await checkAndRecordAttempt(env.sql, ip, hashId("email", `${rnd()}@x.com`))).ok).toBe(true);
    expect(await checkAndRecordAttempt(env.sql, ip, hashId("email", `${rnd()}@x.com`))).toMatchObject({ ok: false, reason: "ip" });
    await env.sql`UPDATE signup_attempts SET created_at = now() - interval '61 minutes' WHERE ip_hash = ${ip}`;
    expect((await checkAndRecordAttempt(env.sql, ip, hashId("email", `${rnd()}@x.com`))).ok).toBe(true);
  });

  it("allows 3 attempts per email per hour across different IPs", async () => {
    const em = hashId("email", `${rnd()}@x.com`);
    for (let i = 0; i < 3; i++) {
      const ip = hashId("ip", ipFor());
      expect((await checkAndRecordAttempt(env.sql, ip, em)).ok).toBe(true);
    }
    const ip = hashId("ip", ipFor());
    expect(await checkAndRecordAttempt(env.sql, ip, em)).toMatchObject({ ok: false, reason: "email" });
    await env.sql`DELETE FROM signup_attempts WHERE email_hash = ${em}`;
  });

  it("parallel attempts cannot exceed the limit", async () => {
    const ip = hashId("ip", ipFor());
    ipHashes.push(ip);
    const rs = await Promise.all(Array.from({ length: 10 }, () => checkAndRecordAttempt(env.sql, ip, hashId("email", `${rnd()}@x.com`))));
    expect(rs.filter((r) => r.ok)).toHaveLength(5);
  });

  it("stores keyed hashes, not raw email or IP; the client IP comes from the trusted end of X-Forwarded-For", async () => {
    const ip = ipFor();
    const email = `${rnd()}@example.com`;
    const legal = fakeLegal();
    await signup(form({ email }), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("open"), ip });
    const rows = await env.sql`SELECT * FROM signup_attempts WHERE ip_hash = ${hashId("ip", ip, E("open"))}`;
    expect(rows).toHaveLength(1);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(email);
    expect(dump).not.toContain(ip);
    expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    const h = (v: string) => ({ get: (k: string) => (k === "x-forwarded-for" ? v : null) });
    expect(clientIp(h("6.6.6.6, 198.51.100.7"))).toBe("198.51.100.7");
    expect(clientIp(h("6.6.6.6, 198.51.100.7, 10.0.0.1"), { SIGNUP_TRUSTED_PROXY_HOPS: "2" })).toBe("198.51.100.7");
    expect(clientIp({ get: () => null })).toBe("unknown");
  });
});

describe("mode gating", () => {
  it("defaults to closed and treats unknown values as closed", () => {
    expect(signupMode({})).toBe("closed");
    expect(signupMode({ SIGNUP_MODE: "OPEN " })).toBe("open");
    expect(signupMode({ SIGNUP_MODE: "invite" })).toBe("invite");
    expect(signupMode({ SIGNUP_MODE: "wide-open" })).toBe("closed");
  });

  it("closed: refuses and never calls LegalAI", async () => {
    const legal = fakeLegal();
    const r = await signup(form(), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("closed"), ip: ipFor() });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(legal.calls).toHaveLength(0);
  });

  it("503 when the provisioning token is not configured (and no call is made)", async () => {
    const legal = fakeLegal();
    const r = await signup(form(), { sql: env.sql, flush: noFlush, fetch: legal.f, env: { SIGNUP_MODE: "open" }, ip: ipFor() });
    expect(r).toMatchObject({ ok: false, status: 503 });
    const r2 = await signup(form(), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("open", { INTERNAL_PROVISION_TOKEN: "short" }), ip: ipFor() });
    expect(r2).toMatchObject({ ok: false, status: 503 });
    expect(legal.calls).toHaveLength(0);
  });

  it("invite: requires a code; a good code creates the account and is used up", async () => {
    const ip = ipFor();
    const legal = fakeLegal();
    expect(await signup(form(), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("invite"), ip })).toMatchObject({ ok: false, status: 400 });
    expect(legal.calls).toHaveLength(0);
    const { code, summary } = await newCodeRow();
    const r = await signup(form({ code: code.toLowerCase() }), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("invite"), ip });
    expect(r).toEqual({ ok: true, next: "/login?created=1" });
    expect(await useCount(summary.id)).toBe(1);
    expect(legal.calls).toHaveLength(1);
    expect(legal.calls[0].url).toBe("http://legal.test/api/internal/users");
    expect(legal.calls[0].headers["x-internal-token"]).toBe(TOKEN);
    expect(Object.keys(legal.calls[0].body).sort()).toEqual(["display_name", "email", "password"]);
    // the same code cannot be used again
    const r2 = await signup(form({ code }), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("invite"), ip: ipFor() });
    expect(r2).toMatchObject({ ok: false, status: 400 });
    expect(legal.calls).toHaveLength(1);
  });

  it("invite: a wrong code is refused without calling LegalAI and the attempt is recorded", async () => {
    const ip = ipFor();
    const legal = fakeLegal();
    const r = await signup(form({ code: "FOS-AAAAA-BBBBB-CCCCC-DDDDD" }), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("invite"), ip });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(legal.calls).toHaveLength(0);
    const [a] = await env.sql<{ outcome: string }[]>`SELECT outcome FROM signup_attempts WHERE ip_hash = ${hashId("ip", ip, E("invite"))}`;
    expect(a.outcome).toBe("invalid_code");
  });

  it("open: no code needed; a code, if sent, is ignored", async () => {
    const legal = fakeLegal();
    const r = await signup(form(), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("open"), ip: ipFor() });
    expect(r.ok).toBe(true);
  });

  it("validates input: terms, password length, email, name", async () => {
    const legal = fakeLegal();
    const d = (o: Record<string, unknown>) => signup(form(o), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("open"), ip: ipFor() });
    expect(await d({ acceptTerms: false })).toMatchObject({ ok: false, status: 400 });
    expect(await d({ acceptTerms: undefined })).toMatchObject({ ok: false, status: 400 });
    expect(await d({ password: "short" })).toMatchObject({ ok: false, status: 400 });
    expect(await d({ email: "nope" })).toMatchObject({ ok: false, status: 400 });
    expect(await d({ displayName: "  " })).toMatchObject({ ok: false, status: 400 });
    expect(await d({ email: "me@example.com", password: "me@example.com" })).toMatchObject({ ok: false, status: 400 });
    expect(await d({ password: "aaaaaaaaaaaaaaaa" })).toMatchObject({ ok: false, status: 400 });
    expect(legal.calls).toHaveLength(0);
  });
});

describe("rollback when LegalAI does not create the account", () => {
  const cases: [string, () => typeof fetch, number][] = [
    ["409 duplicate", () => fakeLegal(409).f, 409],
    ["404 not enabled there", () => fakeLegal(404).f, 503],
    ["401 token mismatch", () => fakeLegal(401).f, 503],
    ["500 error", () => fakeLegal(500).f, 503],
    ["422 rejected", () => fakeLegal(422).f, 400],
    ["network failure", () => (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch, 503],
    ["200 without an id", () => (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch, 503],
  ];
  for (const [name, mk, status] of cases) {
    it(`restores the code use: ${name}`, async () => {
      const { code, summary } = await newCodeRow({ maxUses: 1 });
      const r = await signup(form({ code }), { sql: env.sql, flush: noFlush, fetch: mk(), env: E("invite"), ip: ipFor() });
      expect(r).toMatchObject({ ok: false, status });
      expect(await useCount(summary.id)).toBe(0);
      // and the code still works afterwards
      const ok = await signup(form({ code }), { sql: env.sql, flush: noFlush, fetch: fakeLegal().f, env: E("invite"), ip: ipFor() });
      expect(ok.ok).toBe(true);
      expect(await useCount(summary.id)).toBe(1);
    });
  }

  it("the failure message does not leak the token, password or internal detail", async () => {
    const r = await signup(form(), { sql: env.sql, flush: noFlush, fetch: fakeLegal(500).f, env: E("open"), ip: ipFor() });
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${TOKEN}|a long enough passphrase|legal\\.test`));
  });

  it("concurrent signups on a single-use code create exactly one account", async () => {
    const { code, summary } = await newCodeRow({ maxUses: 1 });
    const legal = fakeLegal();
    const rs = await Promise.all(Array.from({ length: 4 }, () => signup(form({ code }), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("invite"), ip: ipFor() })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(legal.calls).toHaveLength(1);
    expect(await useCount(summary.id)).toBe(1);
  });

  it("rate limits repeated attempts with the same email (3 per hour)", async () => {
    const email = `${rnd()}@example.com`;
    const legal = fakeLegal(409);
    const rs = [];
    for (let i = 0; i < 4; i++) rs.push(await signup(form({ email }), { sql: env.sql, flush: noFlush, fetch: legal.f, env: E("open"), ip: ipFor() }));
    expect(rs.map((r) => (r.ok ? 200 : r.status))).toEqual([409, 409, 409, 429]);
    await env.sql`DELETE FROM signup_attempts WHERE email_hash = ${hashId("email", email, E("open"))}`;
  });
});

describe("password hints", () => {
  it("grades length first", () => {
    expect(passwordHint("short").level).toBe("short");
    expect(passwordHint("aaaaaaaaaaaaaaaa").level).toBe("weak");
    expect(passwordHint("passwordpassword").level).toBe("weak");
    expect(passwordHint("correct horse battery").level).toBe("strong");
    expect(passwordProblem("Me@Example.com", "me@example.com")).not.toBeNull();
    expect(passwordProblem("a long enough passphrase", "me@example.com")).toBeNull();
  });
});
