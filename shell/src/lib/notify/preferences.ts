import { z } from "zod";
import type { Sql } from "@founderos/sdk";

export const PreferencesInput = z.object({
  inApp: z.boolean(),
  email: z.boolean(),
  weeklyBrief: z.boolean(),
  /** Notification types (or severities) to leave out of email. A type is the first part of a dedupe key before ":" (e.g. "reminder"). */
  quietTypes: z.array(z.string().trim().min(1).max(40)).max(30).default([]),
});
export type PreferencesInput = z.infer<typeof PreferencesInput>;

export interface Preferences extends PreferencesInput {
  /** Whether an address is on file for email. The address itself is never returned. */
  hasEmailAddress: boolean;
}

export const DEFAULT_PREFERENCES: PreferencesInput = { inApp: true, email: false, weeklyBrief: true, quietTypes: [] };

interface Row { in_app: boolean; email: boolean; weekly_brief: boolean; quiet_types: string[]; email_address: string | null }

export async function getPreferences(sql: Sql, businessId: string, userId: string): Promise<Preferences> {
  const [r] = await sql<Row[]>`
    SELECT in_app, email, weekly_brief, quiet_types, email_address FROM notification_preferences
    WHERE business_id = ${businessId} AND user_id = ${userId}`;
  if (!r) return { ...DEFAULT_PREFERENCES, hasEmailAddress: false };
  return { inApp: r.in_app, email: r.email, weeklyBrief: r.weekly_brief, quietTypes: r.quiet_types ?? [], hasEmailAddress: Boolean(r.email_address) };
}

/** `emailAddress` must come from the verified session, never from the request body. Omitted = keep the stored one. */
export async function setPreferences(sql: Sql, businessId: string, userId: string, input: unknown, emailAddress?: string | null): Promise<Preferences> {
  const p = PreferencesInput.parse(input);
  const addr = emailAddress?.trim() || null;
  await sql`
    INSERT INTO notification_preferences (business_id, user_id, in_app, email, weekly_brief, quiet_types, email_address)
    VALUES (${businessId}, ${userId}, ${p.inApp}, ${p.email}, ${p.weeklyBrief}, ${sql.json(p.quietTypes)}, ${addr})
    ON CONFLICT (business_id, user_id) DO UPDATE SET
      in_app = EXCLUDED.in_app, email = EXCLUDED.email, weekly_brief = EXCLUDED.weekly_brief, quiet_types = EXCLUDED.quiet_types,
      email_address = COALESCE(EXCLUDED.email_address, notification_preferences.email_address), updated_at = now()`;
  return getPreferences(sql, businessId, userId);
}

export interface Recipient { userId: string; email: string; quietTypes: string[] }

/** People in this business who want email, have an address on file, and (optionally) a single user filter. */
export async function emailRecipients(sql: Sql, businessId: string, opts: { userId?: string; weeklyBrief?: boolean } = {}): Promise<Recipient[]> {
  const rows = await sql<{ user_id: string; email_address: string; quiet_types: string[] }[]>`
    SELECT p.user_id, p.email_address, p.quiet_types
    FROM notification_preferences p
    JOIN business_members m ON m.business_id = p.business_id AND m.user_id = p.user_id
    WHERE p.business_id = ${businessId} AND p.email = true AND p.email_address IS NOT NULL
      ${opts.weeklyBrief ? sql`AND p.weekly_brief = true` : sql``}
      ${opts.userId ? sql`AND p.user_id = ${opts.userId}` : sql``}`;
  return rows.map((r) => ({ userId: r.user_id, email: r.email_address, quietTypes: r.quiet_types ?? [] }));
}
