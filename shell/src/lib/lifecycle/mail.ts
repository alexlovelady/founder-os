import type { Sql } from "@founderos/sdk";
import { enqueueEmail, getEmailProvider, processOutbox } from "@/lib/notify/email";
import { escapeHtml } from "@/lib/notify/markdown";
import type { Env } from "./limits";

/** Subjects used by lifecycle mail (also how the cleanup recognises these rows in the shared outbox). */
export const SUBJECT_RESET = "Reset your FounderOS password";
export const SUBJECT_VERIFY = "Confirm your email address for FounderOS";
export const LIFECYCLE_SUBJECTS = [SUBJECT_RESET, SUBJECT_VERIFY];

export const baseUrl = (env: Env = process.env): string => (env.APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");

/**
 * Email links need an absolute address, so "configured" means: an email provider (RESEND_API_KEY and EMAIL_FROM) AND APP_URL.
 * Without both, nothing that depends on email (reset, verification, therefore open signup) is offered.
 */
export function emailConfigured(env: Env = process.env): boolean {
  return getEmailProvider(env).enabled && /^https?:\/\/\S+$/.test(baseUrl(env));
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export function renderResetEmail(link: string, minutes: number) {
  return {
    subject: SUBJECT_RESET,
    text: `Someone asked to reset the password for your FounderOS account.\n\nChoose a new password: ${link}\n\nThe link works once and expires in ${minutes} minutes. If you did not ask for this, ignore this email: your password stays as it is. If you use two-step verification, it stays on.\n`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="font-size:16px">Reset your password</h2><p>Someone asked to reset the password for your FounderOS account.</p><p><a href="${escapeHtml(link)}">Choose a new password</a></p><p>The link works once and expires in ${minutes} minutes. If you did not ask for this, ignore this email: your password stays as it is. If you use two-step verification, it stays on.</p></div>`,
  };
}

export function renderVerifyEmail(link: string, hours: number) {
  return {
    subject: SUBJECT_VERIFY,
    text: `Confirm this email address to finish creating your FounderOS account:\n\n${link}\n\nThe link works once and expires in ${hours} hours. If you did not sign up, ignore this email: the account is deleted automatically if it is not confirmed.\n`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="font-size:16px">Confirm your email address</h2><p>Confirm this email address to finish creating your FounderOS account.</p><p><a href="${escapeHtml(link)}">Confirm my email</a></p><p>The link works once and expires in ${hours} hours. If you did not sign up, ignore this email: the account is deleted automatically if it is not confirmed.</p></div>`,
  };
}

export interface MailDeps {
  env?: Env;
  /** Send what is queued right now. Injectable (tests pass a no-op). Default: run the outbox with the configured provider. */
  flush?: () => Promise<unknown>;
}

/**
 * Queue a transactional email in the existing outbox (not tied to any business) and try to send it straight away; the hourly outbox job
 * retries failures. Reuses enqueueEmail from lib/notify/email.ts, which already accepts a null business.
 */
export async function queueMail(
  sql: Sql, to: string, mail: { subject: string; text: string; html: string }, deps: MailDeps = {}, opts: { background?: boolean } = {},
): Promise<void> {
  await enqueueEmail(sql, null, to, { subject: oneLine(mail.subject), text: mail.text, html: mail.html });
  const flush = deps.flush ?? (() => processOutbox(sql, { provider: getEmailProvider(deps.env ?? process.env) }));
  // Background: the HTTP answer must not wait for the provider, or its timing would show whether an address has an account.
  if (opts.background) {
    void Promise.resolve().then(flush).catch(() => {});
    return;
  }
  try {
    await flush();
  } catch {
    /* the queued row is retried by the scheduled outbox job */
  }
}

/** Delete finished lifecycle mail (it holds the recipient address and a link whose token is already spent or expired). */
export async function purgeLifecycleMail(sql: Sql, olderThanDays = 2): Promise<number> {
  const rows = await sql`
    DELETE FROM email_outbox WHERE business_id IS NULL AND subject IN ${sql(LIFECYCLE_SUBJECTS)} AND status <> 'queued'
      AND created_at < now() - make_interval(days => ${olderThanDays}) RETURNING id`;
  return rows.length;
}
