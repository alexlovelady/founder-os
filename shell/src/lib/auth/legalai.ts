import type { IdentityProvider, SessionUser } from "./provider";

// Browser-side calls go through the shell's own /legal-ui proxy (same origin), see next.config.ts.
const BASE = "/legal-ui/api/auth";

type RawUser = { id: string; email: string; display_name: string; role: string };
const toUser = (u: RawUser): SessionUser => ({ id: u.id, email: u.email, displayName: u.display_name, role: u.role });

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { credentials: "same-origin", ...init });
  if (!r.ok) {
    let msg = r.statusText;
    try {
      const d = await r.json();
      if (typeof d.detail === "string") msg = d.detail;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const legalAuth: IdentityProvider = {
  async login(email, password) {
    const r = await call<{ user?: RawUser; mfa_required?: boolean; mfa_token?: string }>("/login", json({ email, password }));
    if (r.mfa_required && r.mfa_token) return { kind: "mfa", token: r.mfa_token };
    return { kind: "ok", user: toUser(r.user!) };
  },
  async loginMfa(token, code) {
    const r = await call<{ user: RawUser }>("/login/mfa", json({ mfa_token: token, code }));
    return toUser(r.user);
  },
  async logout() {
    const me = await call<{ csrf_token: string }>("/me");
    await call("/logout", { method: "POST", headers: { "X-CSRF-Token": me.csrf_token } });
  },
};
