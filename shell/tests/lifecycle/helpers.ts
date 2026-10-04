import { randomUUID } from "node:crypto";

export const TOKEN = "x".repeat(40);
export const rnd = () => Math.random().toString(36).slice(2, 10);

/** Email provider settings are present (so the features are on), but tests never send: every call passes `flush: noFlush`. */
export const ENV = (extra: Record<string, string> = {}) => ({
  INTERNAL_PROVISION_TOKEN: TOKEN,
  LEGAL_URL: "http://legal.test",
  RESEND_API_KEY: "re_test_key",
  EMAIL_FROM: "FounderOS <no-reply@example.test>",
  APP_URL: "https://app.example.test",
  ...extra,
});
export const ENV_NO_EMAIL = () => ({ INTERNAL_PROVISION_TOKEN: TOKEN, LEGAL_URL: "http://legal.test" });
export const noFlush = async () => {};

export interface FakeUser { id: string; email: string; active: boolean; password: string; lastAdmin?: boolean }
export interface Call { method: string; path: string; body: Record<string, unknown> | null; token: string | undefined }

/**
 * An in-memory stand-in for LegalAI's private lifecycle endpoints. Records every call. `fail` forces a status for the matching action
 * (for example { password: 500 }) and `deleteStatus` forces the answer of DELETE per user id.
 */
export function fakeLegal() {
  const users = new Map<string, FakeUser>();
  const calls: Call[] = [];
  const fail: Partial<Record<"lookup" | "password" | "activate" | "verify" | "delete", number>> = {};
  const deleteStatus = new Map<string, number>();
  const add = (email: string, o: Partial<FakeUser> = {}): FakeUser => {
    const u = { id: randomUUID(), email: email.toLowerCase(), active: true, password: "current password 123", ...o };
    users.set(u.id, u);
    return u;
  };
  const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const f = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
    const headers = init.headers as Record<string, string>;
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ method, path: u.pathname + u.search, body, token: headers["x-internal-token"] });
    if (headers["x-internal-token"] !== TOKEN) return json(401, { detail: "Invalid token" });
    if (u.pathname === "/api/internal/users/lookup") {
      if (fail.lookup) return json(fail.lookup);
      const found = [...users.values()].find((x) => x.email === String(body?.email) && (x.active || body?.include_inactive === true));
      return found ? json(200, { id: found.id }) : json(404, { detail: "Not found" });
    }
    const m = u.pathname.match(/^\/api\/internal\/users\/([^/]+)(?:\/(password|activate|verify-password))?$/);
    if (!m) return json(404);
    const user = users.get(m[1]);
    const action = m[2];
    if (method === "DELETE") {
      const forced = deleteStatus.get(m[1]) ?? fail.delete;
      if (forced) return json(forced);
      if (!user) return json(404);
      if (u.searchParams.get("only_inactive") === "true" && user.active) return json(409);
      users.delete(user.id);
      return json(200, { deleted: true });
    }
    if (!user) return json(404, { detail: "Not found" });
    if (action === "password") {
      if (fail.password) return json(fail.password);
      user.password = String(body?.password);
      return json(200, { ok: true });
    }
    if (action === "activate") {
      if (fail.activate) return json(fail.activate);
      user.active = true;
      return json(200, { ok: true });
    }
    if (action === "verify-password") {
      if (fail.verify) return json(fail.verify);
      const ok = user.password === String(body?.password);
      return json(200, { ok, last_admin: ok && Boolean(user.lastAdmin) });
    }
    return json(404);
  }) as unknown as typeof fetch;
  return { f, users, calls, fail, deleteStatus, add, called: (re: RegExp) => calls.filter((c) => re.test(`${c.method} ${c.path}`)) };
}

/** The link token inside the most recent outbox mail to `email` (reset or verify). */
export async function lastLinkToken(sql: import("@founderos/sdk").Sql, email: string, kind: "reset" | "verify"): Promise<string | null> {
  const [row] = await sql<{ body_text: string }[]>`SELECT body_text FROM email_outbox WHERE to_email = ${email} ORDER BY created_at DESC, id DESC LIMIT 1`;
  const m = row?.body_text.match(new RegExp(`/${kind}/([A-Za-z0-9_-]+)`));
  return m ? m[1] : null;
}
