import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { ACCOUNT_LIMITS, classifyRequest } from "@/lib/ratelimit/classify";

// The admin route reads the session and the database through these two modules.
const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; email: string; displayName: string; role: string }; cookie: string; csrf: string } }));
const holder = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock("@/lib/auth/server", () => ({ getSession: async () => session.current }));
vi.mock("@/lib/db", () => ({ db: () => holder.sql }));

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv([]);
  holder.sql = env.sql;
});
afterAll(async () => {
  await env.sql`DELETE FROM password_reset_tokens WHERE created_by LIKE 'admin:route-%'`;
  await env.cleanup();
});

const USER_ID = "7d444840-9dc0-4e84-b6a3-1ad5b2f5d6a1";
const post = async (body: unknown, headers: Record<string, string> = {}) => {
  const { POST } = await import("@/app/api/account/admin-reset-link/route");
  return POST(new Request("http://localhost/api/account/admin-reset-link", { method: "POST", headers: { "content-type": "application/json", host: "localhost", ...headers }, body: JSON.stringify(body) }));
};
const as = (role: string | null) => {
  session.current = role ? { user: { id: `route-${role}`, email: "a@example.com", displayName: "A", role }, cookie: "c", csrf: "x" } : null;
};

describe("admin-created reset link route", () => {
  it("is invisible (404) to signed-out people and ordinary users, and creates nothing for them", async () => {
    for (const role of [null, "user", "viewer"]) {
      as(role);
      const r = await post({ userId: USER_ID });
      expect(r.status).toBe(404);
    }
    expect(await env.sql`SELECT 1 FROM password_reset_tokens WHERE user_id = ${USER_ID}`).toHaveLength(0);
  });

  it("platform admin gets a one-time path; only the hash is stored; the action is audited", async () => {
    as("admin");
    const r = await post({ userId: USER_ID });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as { path: string; expiresAt: string };
    expect(body.path).toMatch(/^\/reset\/[A-Za-z0-9_-]{43}$/);
    const token = body.path.slice(7);
    const rows = await env.sql`SELECT * FROM password_reset_tokens WHERE user_id = ${USER_ID} AND created_by = 'admin:route-admin'`;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    const audit = await env.sql`SELECT * FROM audit_events WHERE action = 'admin.user.reset_link_created' AND user_id = 'route-admin' AND resource_id = ${USER_ID}`;
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it("validates the body and blocks cross-site requests", async () => {
    as("admin");
    expect((await post({})).status).toBe(400);
    expect((await post({ userId: "../etc" })).status).toBe(400);
    expect((await post({ userId: USER_ID }, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("rate limit rules for the account routes", () => {
  const summary = (m: string, p: string) => classifyRequest(m, p).map((r) => `${r.bucket}:${r.limit}/${r.windowMs / 1000}s`);

  it("strict per-IP rules apply to every new API route (in addition to the general ones)", () => {
    expect(summary("POST", "/api/account/forgot")).toEqual(["acct-mail:5/600s", "api-mutating:60/60s", "api:600/60s"]);
    expect(summary("POST", "/api/account/resend-verification")).toEqual(["acct-mail:5/600s", "api-mutating:60/60s", "api:600/60s"]);
    expect(summary("POST", "/api/account/reset")).toEqual(["acct-token:10/600s", "api-mutating:60/60s", "api:600/60s"]);
    expect(summary("POST", "/api/account/verify")).toEqual(["acct-token:10/600s", "api-mutating:60/60s", "api:600/60s"]);
    expect(summary("POST", "/api/account/delete")).toEqual(["acct-sensitive:5/600s", "api-mutating:60/60s", "api:600/60s"]);
    expect(summary("POST", "/api/account/admin-reset-link")).toEqual(["acct-admin:20/600s", "api-mutating:60/60s", "api:600/60s"]);
    expect(summary("POST", "/api/account/forgot/")).toEqual(summary("POST", "/api/account/forgot")); // trailing slash
    expect(summary("POST", "/API/Account/Forgot")).toEqual(summary("POST", "/api/account/forgot")); // case
  });

  it("the public pages are limited per IP too (once the proxy matcher includes them)", () => {
    for (const p of ["/forgot", "/verify", "/reset/abc", "/verify/abc"]) expect(summary("GET", p)).toEqual([`acct-page:${ACCOUNT_LIMITS.page}/60s`]);
    expect(summary("GET", "/login")).toEqual([]);
    expect(summary("GET", "/resetting")).toEqual([]);
  });

  it("the old privacy route keeps its normal rules", () => {
    expect(summary("POST", "/api/privacy/delete-account")).toEqual(["api-mutating:60/60s", "api:600/60s"]);
  });
});
