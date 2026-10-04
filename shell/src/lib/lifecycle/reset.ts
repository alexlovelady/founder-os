import { z } from "zod";
import type { Sql } from "@founderos/sdk";
import { recordAudit } from "@/lib/platform/audit";
import { MIN_PASSWORD, passwordProblem } from "@/lib/signup/password";
import { checkAndRecord, hashIp, hashSubject, type Env } from "./limits";
import { isUserId, legalCall, lookupUser, userPath, type LegalDeps } from "./legal";
import { baseUrl, emailConfigured, queueMail, renderResetEmail, type MailDeps } from "./mail";
import { ADMIN_RESET_HOURS, SELF_RESET_MINUTES, claimToken, hashToken, newToken, releaseToken, tokenIsLive } from "./tokens";

export interface LifecycleDeps extends LegalDeps, MailDeps {
  /** Raw client IP (see clientIp in lib/signup/limits). Hashed before it is stored. */
  ip: string;
}

export const FORGOT_GENERIC = `If an account exists for that email address, we have sent a link to reset the password. The link works once and expires in ${SELF_RESET_MINUTES} minutes.`;
export const RESET_NOT_AVAILABLE = "Password reset by email is not available yet. Ask your administrator for a reset link.";
export const LINK_INVALID = "This link is invalid, has expired, or has already been used. Request a new one.";

const EmailInput = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(320)) });

export type ForgotResult =
  | { ok: true; available: boolean; message: string }
  | { ok: false; status: 400 | 429; message: string };

async function insertToken(sql: Sql, userId: string, createdBy: string, ttlMs: number): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + ttlMs);
  await sql`INSERT INTO password_reset_tokens (user_id, token_hash, created_by, expires_at) VALUES (${userId}, ${hashToken(token)}, ${createdBy}, ${expiresAt})`;
  return { token, expiresAt };
}

/**
 * Self-serve "forgot password". Answers the SAME generic message whether or not the address has an account, and whether or not a mail was
 * queued (a per-email limit hit is also silent), so the answer cannot be used to find out who has an account. Only a malformed address (400)
 * and a per-IP limit (429) differ, and neither depends on the account. When email is not configured nothing is created at all.
 */
export async function requestPasswordReset(sql: Sql, raw: unknown, deps: LifecycleDeps): Promise<ForgotResult> {
  const env: Env = deps.env ?? process.env;
  const parsed = EmailInput.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, message: "Enter a valid email address." };
  if (!emailConfigured(env)) return { ok: true, available: false, message: RESET_NOT_AVAILABLE };
  const email = parsed.data.email;
  const lim = await checkAndRecord(sql, "forgot", hashIp(deps.ip, env), hashSubject(email, env));
  if (!lim.ok && lim.reason === "ip") return { ok: false, status: 429, message: "Too many requests. Please wait an hour and try again." };
  if (lim.ok) {
    try {
      const userId = await lookupUser(email, deps);
      if (userId) {
        const { token } = await insertToken(sql, userId, "self", SELF_RESET_MINUTES * 60_000);
        await queueMail(sql, email, renderResetEmail(`${baseUrl(env)}/reset/${token}`, SELF_RESET_MINUTES), deps, { background: true });
        await recordAudit(sql, { businessId: null, userId, action: "account.reset_requested", resource: { tool: "platform", id: userId }, meta: { by: "self" } });
      }
    } catch {
      /* same answer either way */
    }
  }
  return { ok: true, available: true, message: FORGOT_GENERIC };
}

export type AdminLinkResult = { ok: true; path: string; expiresAt: string } | { ok: false; status: 400; message: string };

/**
 * A reset link an administrator hands to a user out of band. The caller MUST have verified platform-admin access. The raw token is returned
 * once (as a path; the page adds the origin) and only its hash is stored. Valid 24 hours, single use. Audited without the token.
 */
export async function createAdminResetLink(sql: Sql, a: { adminId: string; targetUserId: string }): Promise<AdminLinkResult> {
  if (!isUserId(a.targetUserId)) return { ok: false, status: 400, message: "That is not a valid user id." };
  const { token, expiresAt } = await insertToken(sql, a.targetUserId, `admin:${a.adminId}`, ADMIN_RESET_HOURS * 3_600_000);
  await recordAudit(sql, {
    businessId: null, userId: a.adminId, action: "admin.user.reset_link_created", resource: { tool: "platform", id: a.targetUserId },
    meta: { expiresInHours: ADMIN_RESET_HOURS },
  });
  return { ok: true, path: `/reset/${token}`, expiresAt: expiresAt.toISOString() };
}

/** For the reset page: is this link still usable? Does not consume it. */
export const resetTokenValid = (sql: Sql, token: string): Promise<boolean> => tokenIsLive(sql, "password_reset_tokens", token);

const ResetInput = z.object({
  token: z.string().min(20).max(128),
  password: z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters for the password.`).max(256, "That password is too long."),
});

export type ResetResult = { ok: true; next: string } | { ok: false; status: 400 | 429 | 503; message: string };

/**
 * Use a reset link. The password is validated first (a typo never burns the link), then the token is claimed with one conditional UPDATE
 * (single use even under concurrency), then LegalAI sets the password and revokes every session. If LegalAI cannot do it the claim is given
 * back so the person can retry. After success every other outstanding link for that user is revoked. MFA is not touched anywhere.
 */
export async function completeReset(sql: Sql, raw: unknown, deps: LifecycleDeps): Promise<ResetResult> {
  const env: Env = deps.env ?? process.env;
  const lim = await checkAndRecord(sql, "reset", hashIp(deps.ip, env), null);
  if (!lim.ok) return { ok: false, status: 429, message: "Too many attempts. Please wait an hour and try again." };
  const parsed = ResetInput.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  const { token, password } = parsed.data;
  const weak = passwordProblem(password, "");
  if (weak) return { ok: false, status: 400, message: weak };

  const claim = await claimToken(sql, "password_reset_tokens", token);
  if (!claim) return { ok: false, status: 400, message: LINK_INVALID };
  const r = await legalCall("POST", userPath(claim.userId, "/password"), { password }, deps);
  if (r?.status === 200) {
    await sql`UPDATE password_reset_tokens SET used_at = now() WHERE user_id = ${claim.userId} AND used_at IS NULL`;
    await recordAudit(sql, {
      businessId: null, userId: claim.userId, action: "account.password_reset", resource: { tool: "platform", id: claim.userId },
      meta: { by: claim.createdBy === "self" ? "self" : "admin" },
    });
    return { ok: true, next: "/login?reset=1" };
  }
  if (r?.status === 404) return { ok: false, status: 400, message: LINK_INVALID }; // the account is gone: the link stays spent
  await releaseToken(sql, "password_reset_tokens", claim.id);
  if (r?.status === 422) return { ok: false, status: 400, message: "That password was not accepted. Choose a different one." };
  return { ok: false, status: 503, message: "We could not change the password right now. Please try again in a few minutes." };
}
