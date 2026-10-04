// Local-only smoke test of the account flows across LegalAI and the shell, using throwaway accounts on the local development databases.
// Usage: node scripts/local_account_flows.mjs   (shell on :3000 with SIGNUP_MODE=invite and INTERNAL_PROVISION_TOKEN set; admin = uitest account)
const BASE = "http://localhost:3000";
const ADMIN = { email: "uitest@example.com", password: process.env.ADMIN_PW ?? "" };
if (!ADMIN.password) throw new Error("set ADMIN_PW (the local throwaway admin password)");

class Jar {
  cookies = new Map();
  async fetch(path, init = {}) {
    const headers = { ...(init.headers ?? {}), cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "), origin: BASE };
    const r = await fetch(BASE + path, { ...init, headers, redirect: "manual" });
    for (const c of r.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return r;
  }
  json = (path, method, body) => this.fetch(path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
}

const out = [];
const check = (name, ok, extra = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
  return ok;
};

const login = async (email, password) => {
  const j = new Jar();
  const r = await j.json("/legal-ui/api/auth/login", "POST", { email, password });
  return { j, status: r.status, body: await r.json().catch(() => ({})) };
};

const stamp = Date.now().toString(36);
const email = `flow-${stamp}@example.com`;
const pw1 = `First-pass-${stamp}-Aa1`;
const pw2 = `Second-pass-${stamp}-Bb2`;

// 1. admin creates an invite code
const admin = await login(ADMIN.email, ADMIN.password);
check("admin can sign in", admin.status === 200);
const made = await admin.j.json("/api/admin/signup/codes", "POST", { label: "flow test", maxUses: 1, expiresInDays: 1 });
const madeBody = await made.json().catch(() => ({}));
const code = madeBody.code ?? madeBody.rawCode;
check("admin creates an invite code", made.status < 300 && typeof code === "string", `status ${made.status}`);

// 2. signup with the code
const anon = new Jar();
const bad = await anon.json("/api/signup", "POST", { email, password: pw1, displayName: "Flow Tester", code: "FOS-AAAAA-AAAAA-AAAAA-AAAAA", acceptTerms: true });
check("signup with a wrong code is refused", bad.status >= 400, `status ${bad.status}`);
const su = await anon.json("/api/signup", "POST", { email, password: pw1, displayName: "Flow Tester", code, acceptTerms: true });
check("signup with the code succeeds", su.status < 300, `status ${su.status} ${JSON.stringify(await su.json().catch(() => ({}))).slice(0, 100)}`);
const reuse = await anon.json("/api/signup", "POST", { email: `other-${stamp}@example.com`, password: pw1, displayName: "X", code, acceptTerms: true });
check("a single-use code cannot be reused", reuse.status >= 400, `status ${reuse.status}`);

// 3. the new user signs in
const u1 = await login(email, pw1);
check("new user signs in", u1.status === 200);

// 4. admin creates a reset link for them (needs the user id)
const me = await (await u1.j.fetch("/legal-ui/api/auth/me")).json();
const uid = me.user?.id;
const link = await admin.j.json("/api/account/admin-reset-link", "POST", { userId: uid });
const linkBody = await link.json().catch(() => ({}));
const token = (linkBody.link ?? linkBody.url ?? linkBody.path ?? "").split("/").pop();
check("admin creates a one-time reset link", link.status < 300 && token.length > 20, `status ${link.status}`);

// 5. use the link
const reset = await anon.json("/api/account/reset", "POST", { token, password: pw2 });
check("reset link sets a new password", reset.status < 300, `status ${reset.status}`);
const again = await anon.json("/api/account/reset", "POST", { token, password: `Third-pass-${stamp}-Cc3` });
check("the link works only once", again.status >= 400, `status ${again.status}`);
const oldSession = await u1.j.fetch("/legal-ui/api/auth/me");
check("old sessions are revoked after a reset", oldSession.status === 401, `status ${oldSession.status}`);
check("old password no longer works", (await login(email, pw1)).status === 401);
const u2 = await login(email, pw2);
check("new password works", u2.status === 200);

// 6. forgot-password gives the same answer for known and unknown emails
const f1 = await anon.json("/api/account/forgot", "POST", { email });
const f2 = await anon.json("/api/account/forgot", "POST", { email: `nobody-${stamp}@example.com` });
check("forgot-password does not reveal which emails exist", f1.status === f2.status && JSON.stringify(await f1.json()) === JSON.stringify(await f2.json()));

// 7. delete the account (sole member of no business: simple case)
const del = await u2.j.json("/api/account/delete", "POST", { confirmEmail: email, password: pw2 });
check("account deletion succeeds", del.status < 300, `status ${del.status} ${JSON.stringify(await del.json().catch(() => ({}))).slice(0, 120)}`);
check("deleted account can no longer sign in", (await login(email, pw2)).status === 401);

console.log(out.join("\n"));
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
