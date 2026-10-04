import { z } from "zod";
import type { Sql } from "@founderos/sdk";
import { recordAudit } from "@/lib/platform/audit";
import { checkAndRecord, hashIp, hashSubject, type Env } from "./limits";
import { legalCall, lookupUser, userPath, type LegalDeps } from "./legal";
import { baseUrl, emailConfigured, purgeLifecycleMail, queueMail, renderVerifyEmail, type MailDeps } from "./mail";
import type { LifecycleDeps } from "./reset";
import { UNVERIFIED_PURGE_DAYS, VERIFY_HOURS, claimToken, hashToken, newToken, releaseToken, tokenIsLive } from "./tokens";

export const RESEND_GENERIC = "If that address has an account waiting for confirmation, we have sent a new link. It works once and expires in 24 hours.";
export const VERIFY_NOT_AVAILABLE = "Email is not configured, so confirmation links cannot be sent. Ask your administrator.";
export const VERIFY_LINK_INVALID = "This confirmation link is invalid, has expired, or has already been used. If you already confirmed, sign in. Otherwise request a new link.";

/**
 * Store a verification token for an inactive account and queue the email. The address is NOT stored with the token: it lives only in the
 * outbox row until the mail is sent and the cleanup removes it. Returns false when the mail could not even be queued.
 */
export async function startVerification(sql: Sql, userId: string, email: string, deps: MailDeps & { background?: boolean }): Promise<boolean> {
  const env: Env = deps.env ?? process.env;
  const token = newToken();
  try {
    await sql`INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (${userId}, ${hashToken(token)}, ${new Date(Date.now() + VERIFY_HOURS * 3_600_000)})`;
    await queueMail(sql, email, renderVerifyEmail(`${baseUrl(env)}/verify/${token}`, VERIFY_HOURS), deps, { background: deps.background });
    return true;
  } catch {
    return false;
  }
}

export const verifyTokenValid = (sql: Sql, token: string): Promise<boolean> => tokenIsLive(sql, "email_verifications", token);

export type VerifyResult = { ok: true; next: string } | { ok: false; status: 400 | 429 | 503; message: string };

/** Use a verification link: claim it atomically (single use), then ask LegalAI to activate the account. The claim is given back on failure. */
export async function confirmVerification(sql: Sql, token: unknown, deps: LifecycleDeps): Promise<VerifyResult> {
  const env: Env = deps.env ?? process.env;
  const lim = await checkAndRecord(sql, "verify", hashIp(deps.ip, env), null);
  if (!lim.ok) return { ok: false, status: 429, message: "Too many attempts. Please wait an hour and try again." };
  const claim = await claimToken(sql, "email_verifications", typeof token === "string" ? token : "");
  if (!claim) return { ok: false, status: 400, message: VERIFY_LINK_INVALID };
  const r = await legalCall("POST", userPath(claim.userId, "/activate"), undefined, deps);
  if (r?.status === 200) {
    await sql`UPDATE email_verifications SET used_at = now() WHERE user_id = ${claim.userId} AND used_at IS NULL`;
    await recordAudit(sql, { businessId: null, userId: claim.userId, action: "account.email_verified", resource: { tool: "platform", id: claim.userId } });
    return { ok: true, next: "/login?verified=1" };
  }
  if (r?.status === 404) return { ok: false, status: 400, message: VERIFY_LINK_INVALID }; // the account was removed (cleanup): the link stays spent
  await releaseToken(sql, "email_verifications", claim.id);
  return { ok: false, status: 503, message: "We could not confirm your email right now. Please try again in a few minutes." };
}

const EmailInput = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(320)) });
export type ResendResult =
  | { ok: true; available: boolean; message: string }
  | { ok: false; status: 400 | 429; message: string };

/**
 * Send a new confirmation link. Generic answer whatever the address is. A link is only created for an account that LegalAI says is
 * not yet active AND for which we hold an earlier verification record, so this can never touch an account suspended for another reason.
 */
export async function resendVerification(sql: Sql, raw: unknown, deps: LifecycleDeps): Promise<ResendResult> {
  const env: Env = deps.env ?? process.env;
  const parsed = EmailInput.safeParse(raw);
  if (!parsed.success) return { ok: false, status: 400, message: "Enter a valid email address." };
  if (!emailConfigured(env)) return { ok: true, available: false, message: VERIFY_NOT_AVAILABLE };
  const email = parsed.data.email;
  const lim = await checkAndRecord(sql, "resend", hashIp(deps.ip, env), hashSubject(email, env));
  if (!lim.ok && lim.reason === "ip") return { ok: false, status: 429, message: "Too many requests. Please wait an hour and try again." };
  if (lim.ok) {
    try {
      const userId = await lookupUser(email, deps, true);
      if (userId) {
        const pending = await sql`SELECT 1 FROM email_verifications WHERE user_id = ${userId} AND used_at IS NULL LIMIT 1`;
        if (pending.length) await startVerification(sql, userId, email, { ...deps, background: true });
      }
    } catch {
      /* same answer either way */
    }
  }
  return { ok: true, available: true, message: RESEND_GENERIC };
}

export interface PurgeDeps extends LegalDeps { now?: Date }
export interface PurgeResult { purged: number; skipped: number; mail: number }

/**
 * SCHEDULED CLEANUP (the lead must run this, for example daily): delete accounts that were created inactive and never confirmed within 7
 * days, and finished lifecycle mail. Each account is removed in LegalAI with `only_inactive=true`, which refuses (409) if it has since become
 * active, so a confirmed or reactivated account can never be deleted by mistake. Idempotent; failures leave the rows for the next run.
 */
export async function purgeUnverified(sql: Sql, deps: PurgeDeps = {}): Promise<PurgeResult> {
  const cutoff = new Date((deps.now ?? new Date()).getTime() - UNVERIFIED_PURGE_DAYS * 86_400_000);
  const stale = await sql<{ user_id: string }[]>`
    SELECT user_id FROM email_verifications GROUP BY user_id
    HAVING min(created_at) < ${cutoff} AND bool_and(used_at IS NULL)`;
  let purged = 0;
  let skipped = 0;
  for (const { user_id } of stale) {
    const r = await legalCall("DELETE", `${userPath(user_id)}?only_inactive=true`, undefined, deps);
    if (r && (r.status === 200 || r.status === 404 || r.status === 409)) {
      await sql`DELETE FROM email_verifications WHERE user_id = ${user_id}`;
      await sql`DELETE FROM password_reset_tokens WHERE user_id = ${user_id}`;
      if (r.status === 200) {
        purged++;
        await recordAudit(sql, { businessId: null, userId: user_id, action: "account.unverified_purged", resource: { tool: "platform", id: user_id } });
      } else skipped++;
    } else skipped++;
  }
  const mail = await purgeLifecycleMail(sql);
  return { purged, skipped, mail };
}
