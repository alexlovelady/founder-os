import { z } from "zod";
import type { NotifyInput, Sql } from "@founderos/sdk";
import { enqueueEmail, getEmailProvider, renderNotificationEmail } from "./email";
import { emailRecipients } from "./preferences";

export * from "./preferences";
export { getEmailProvider, processOutbox, type EmailProvider } from "./email";

export const NotifyInputSchema = z.object({
  // Long text from tools is shortened rather than rejected: a notification must never be lost over its length.
  title: z.string().trim().min(1).transform((s) => s.slice(0, 200)),
  body: z.string().transform((s) => s.slice(0, 2000)).optional(),
  href: z.string().transform((s) => s.slice(0, 500)).optional(),
  severity: z.enum(["info", "review", "high"]).optional(),
  dedupeKey: z.string().min(1).max(300).optional(),
});

export interface NotificationOpts {
  /** Omit for a notification to the whole business. */
  userId?: string;
  /** Defaults to whether an email provider is configured. Tests and the scheduler pass it explicitly. */
  emailEnabled?: boolean;
}

export interface Notification {
  id: string;
  userId: string | null;
  title: string;
  body: string;
  href: string | null;
  severity: "info" | "review" | "high";
  read: boolean;
  createdAt: string;
}

/** The "type" of a notification is the first part of its dedupe key before ":" (e.g. "reminder:tasks-1:2026-10-01" is type "reminder"). */
export const notificationType = (dedupeKey?: string) => (dedupeKey ? dedupeKey.split(":")[0] : "");

/**
 * Put a message in the business inbox. The same (business, dedupeKey) twice is one notification, and only the first call can email.
 * Email goes only to members who turned email on, have an address on file, and have not muted this type or severity.
 */
export async function createNotification(sql: Sql, businessId: string, input: NotifyInput, opts: NotificationOpts = {}): Promise<{ id: string | null; created: boolean }> {
  const n = NotifyInputSchema.parse(input);
  const severity = n.severity ?? "info";
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO notifications (business_id, user_id, title, body, href, severity, dedupe_key)
    VALUES (${businessId}, ${opts.userId ?? null}, ${n.title}, ${n.body ?? ""}, ${n.href && /^(\/(?!\/)|https?:\/\/)/.test(n.href) ? n.href : null},${severity}, ${n.dedupeKey ?? null})
    ON CONFLICT (business_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id`;
  if (!row) return { id: null, created: false };

  if (opts.emailEnabled ?? getEmailProvider().enabled) {
    const type = notificationType(n.dedupeKey);
    const recipients = (await emailRecipients(sql, businessId, { userId: opts.userId })).filter((r) => !r.quietTypes.includes(severity) && !(type && r.quietTypes.includes(type)));
    if (recipients.length) {
      const mail = renderNotificationEmail(n);
      for (const r of recipients) await enqueueEmail(sql, businessId, r.email, mail);
    }
  }
  return { id: row.id, created: true };
}

interface Row { id: string; user_id: string | null; title: string; body: string; href: string | null; severity: Notification["severity"]; read_at: Date | null; created_at: Date }
const toNotification = (r: Row): Notification => ({ id: r.id, userId: r.user_id, title: r.title, body: r.body, href: r.href, severity: r.severity, read: r.read_at !== null, createdAt: r.created_at.toISOString() });

async function inAppOn(sql: Sql, businessId: string, userId: string): Promise<boolean> {
  const [p] = await sql<{ in_app: boolean }[]>`SELECT in_app FROM notification_preferences WHERE business_id = ${businessId} AND user_id = ${userId}`;
  return p ? p.in_app : true;
}

/** Newest first. A user sees notifications addressed to them and to the whole business. Hidden entirely if they turned in-app off. */
export async function listNotifications(sql: Sql, businessId: string, userId: string, opts: { limit?: number; unreadOnly?: boolean } = {}): Promise<Notification[]> {
  if (!(await inAppOn(sql, businessId, userId))) return [];
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const rows = await sql<Row[]>`
    SELECT id, user_id, title, body, href, severity, read_at, created_at FROM notifications
    WHERE business_id = ${businessId} AND (user_id IS NULL OR user_id = ${userId}) ${opts.unreadOnly ? sql`AND read_at IS NULL` : sql``}
    ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return rows.map(toNotification);
}

export async function unreadCount(sql: Sql, businessId: string, userId: string): Promise<number> {
  if (!(await inAppOn(sql, businessId, userId))) return 0;
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM notifications WHERE business_id = ${businessId} AND (user_id IS NULL OR user_id = ${userId}) AND read_at IS NULL`;
  return r.n;
}

/** Business-wide notifications share one read state: reading one marks it read for the whole business. */
export async function markRead(sql: Sql, businessId: string, userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const rows = await sql`
    UPDATE notifications SET read_at = COALESCE(read_at, now())
    WHERE id = ${id} AND business_id = ${businessId} AND (user_id IS NULL OR user_id = ${userId}) RETURNING id`;
  return rows.length > 0;
}

export async function markAllRead(sql: Sql, businessId: string, userId: string): Promise<number> {
  const rows = await sql`
    UPDATE notifications SET read_at = now()
    WHERE business_id = ${businessId} AND (user_id IS NULL OR user_id = ${userId}) AND read_at IS NULL RETURNING id`;
  return rows.length;
}
