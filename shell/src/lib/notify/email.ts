import type { Sql } from "@founderos/sdk";
import { escapeHtml, markdownToHtml } from "./markdown";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable id so a provider can de-duplicate a retried send. */
  idempotencyKey?: string;
}

export type SendResult = { ok: true; id?: string } | { ok: false; error: string; retryable: boolean };

export interface EmailProvider {
  name: string;
  /** False means nothing will ever be sent: callers must not pretend otherwise. */
  enabled: boolean;
  send(msg: EmailMessage): Promise<SendResult>;
}

/** Used when no email key is configured. It never sends and says so. */
export const disabledProvider: EmailProvider = {
  name: "disabled",
  enabled: false,
  async send() {
    return { ok: false, error: "email disabled", retryable: false };
  },
};

export function resendProvider(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): EmailProvider {
  return {
    name: "resend",
    enabled: true,
    async send(msg) {
      try {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            ...(msg.idempotencyKey ? { "idempotency-key": msg.idempotencyKey } : {}),
          },
          body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
        });
        if (res.ok) {
          const j = (await res.json().catch(() => ({}))) as { id?: string };
          return { ok: true, id: j.id };
        }
        // Never copy the response body: it can echo the recipient address.
        return { ok: false, error: `Email provider returned HTTP ${res.status}`, retryable: res.status === 429 || res.status >= 500 };
      } catch {
        return { ok: false, error: "Could not reach the email provider", retryable: true };
      }
    },
  };
}

/** Resend when RESEND_API_KEY and EMAIL_FROM are both set; otherwise the disabled provider. */
export function getEmailProvider(env: Record<string, string | undefined> = process.env): EmailProvider {
  const key = env.RESEND_API_KEY?.trim();
  const from = env.EMAIL_FROM?.trim();
  return key && from ? resendProvider(key, from) : disabledProvider;
}

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 6 * 3_600_000;

/** Delay before the next try after `attempts` failed tries: 5 min, 10, 20, 40, ... capped at 6 hours. */
export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

const appUrl = () => (process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

function footer() {
  const settings = `${appUrl()}/app/notifications`;
  return { text: `\n--\nChange or stop these emails: ${settings}`, html: `<p style="margin-top:24px;font-size:12px;color:#64748b">Change or stop these emails in your <a href="${escapeHtml(settings)}">notification settings</a>.</p>` };
}

export function renderNotificationEmail(n: { title: string; body?: string; href?: string }): { subject: string; text: string; html: string } {
  const f = footer();
  const link = n.href ? (n.href.startsWith("/") ? appUrl() + n.href : n.href) : "";
  const safeLink = /^(https?:\/\/|\/)/.test(link) ? link : "";
  return {
    subject: oneLine(n.title, 150),
    text: `${n.title}\n${n.body ? `\n${n.body}\n` : ""}${safeLink ? `\nOpen: ${safeLink}\n` : ""}${f.text}`,
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px"><h2 style="font-size:16px">${escapeHtml(n.title)}</h2>${n.body ? `<p>${escapeHtml(n.body)}</p>` : ""}${safeLink ? `<p><a href="${escapeHtml(safeLink)}">Open in FounderOS</a></p>` : ""}${f.html}</div>`,
  };
}

export function renderBriefEmail(subject: string, contentMd: string): { subject: string; text: string; html: string } {
  const f = footer();
  return {
    subject: oneLine(subject, 150),
    text: contentMd + f.text,
    html: `<div style="font-family:system-ui,sans-serif;max-width:560px">${markdownToHtml(contentMd)}${f.html}</div>`,
  };
}

export async function enqueueEmail(sql: Sql, businessId: string | null, to: string, mail: { subject: string; text: string; html: string }): Promise<void> {
  await sql`INSERT INTO email_outbox (business_id, to_email, subject, body_text, body_html) VALUES (${businessId}, ${to}, ${mail.subject}, ${mail.text}, ${mail.html})`;
}

export interface OutboxResult { sent: number; retried: number; failed: number; disabled: number }

/**
 * Send what is due. Each row is claimed first (attempts + 1 and a short lease on next_attempt_at, using SKIP LOCKED) so two workers never send the
 * same message; the outcome then sets it to sent, back to queued with exponential backoff, or failed once `maxAttempts` is used up.
 */
export async function processOutbox(
  sql: Sql,
  opts: { provider?: EmailProvider; now?: Date; batch?: number; maxAttempts?: number } = {},
): Promise<OutboxResult> {
  const provider = opts.provider ?? getEmailProvider();
  const now = opts.now ?? new Date();
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const result: OutboxResult = { sent: 0, retried: 0, failed: 0, disabled: 0 };

  if (!provider.enabled) {
    const rows = await sql`UPDATE email_outbox SET status = 'disabled', last_error = 'email disabled' WHERE status = 'queued' RETURNING id`;
    result.disabled = rows.length;
    return result;
  }

  const lease = new Date(now.getTime() + 10 * 60_000);
  const claimed = await sql<{ id: string; to_email: string; subject: string; body_text: string; body_html: string; attempts: number }[]>`
    UPDATE email_outbox SET attempts = attempts + 1, next_attempt_at = ${lease}
    WHERE id IN (
      SELECT id FROM email_outbox WHERE status = 'queued' AND next_attempt_at <= ${now}
      ORDER BY created_at LIMIT ${opts.batch ?? 50} FOR UPDATE SKIP LOCKED)
    RETURNING id, to_email, subject, body_text, body_html, attempts`;

  for (const row of claimed) {
    let r: SendResult;
    try {
      r = await provider.send({ to: row.to_email, subject: row.subject, text: row.body_text, html: row.body_html, idempotencyKey: row.id });
    } catch {
      r = { ok: false, error: "Send failed", retryable: true };
    }
    if (r.ok) {
      await sql`UPDATE email_outbox SET status = 'sent', sent_at = ${now}, last_error = NULL WHERE id = ${row.id}`;
      result.sent++;
    } else if (r.retryable && row.attempts < maxAttempts) {
      await sql`UPDATE email_outbox SET status = 'queued', last_error = ${r.error}, next_attempt_at = ${new Date(now.getTime() + backoffMs(row.attempts))} WHERE id = ${row.id}`;
      result.retried++;
    } else {
      await sql`UPDATE email_outbox SET status = 'failed', last_error = ${r.error} WHERE id = ${row.id}`;
      result.failed++;
    }
  }
  return result;
}
