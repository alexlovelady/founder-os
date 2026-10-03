import { z } from "zod";
import type { Sql } from "@founderos/sdk";

export const EVENT_NAMES = [
  "signup_completed", "onboarding_completed", "document_uploaded", "document_review_started", "founder_ai_message",
  "health_item_completed", "compliance_item_completed", "calculator_used", "subscription_started", "subscription_upgraded", "subscription_canceled",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];
export const isEventName = (n: unknown): n is EventName => typeof n === "string" && (EVENT_NAMES as readonly string[]).includes(n);

const SENSITIVE_KEY = /pass(word|wd)?|token|secret|key|authorization|cookie|credential|email|phone|content|text|body|message|prompt|name/i;

/** Only small scalar properties survive (<= 10 keys, strings <= 100 chars). Anything that looks personal or like content is dropped. Pure. */
export function sanitizeProps(props: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!props || typeof props !== "object" || Array.isArray(props)) return out;
  for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
    if (Object.keys(out).length >= 10) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) || SENSITIVE_KEY.test(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, 100);
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

export const EventInput = z.object({
  name: z.enum(EVENT_NAMES),
  props: z.record(z.string(), z.unknown()).optional(),
});

/** Whether a business allows product analytics (default true when it never chose). */
export async function analyticsAllowed(sql: Sql, businessId: string): Promise<boolean> {
  const [row] = await sql<{ allow_product_analytics: boolean }[]>`SELECT allow_product_analytics FROM privacy_settings WHERE business_id = ${businessId}`;
  return row ? row.allow_product_analytics : true;
}

/** Record a product event. Honors the business's privacy setting; never throws. Returns true when stored. */
export async function trackEvent(sql: Sql, e: { businessId: string | null; userId: string | null; name: string; props?: unknown }): Promise<boolean> {
  try {
    if (!isEventName(e.name)) return false;
    if (e.businessId && !(await analyticsAllowed(sql, e.businessId))) return false;
    await sql`INSERT INTO analytics_events (business_id, user_id, name, props) VALUES (${e.businessId}, ${e.userId}, ${e.name}, ${sql.json(sanitizeProps(e.props) as never)})`;
    return true;
  } catch (err) {
    console.error("analytics write failed", (err as { code?: string }).code ?? "");
    return false;
  }
}

export interface EventDayCount { day: string; name: string; count: number }

/** Counts by event and day for the last `days` days (admin analytics). */
export async function eventCountsByDay(sql: Sql, days = 30): Promise<EventDayCount[]> {
  const d = Math.min(Math.max(Math.floor(days), 1), 365);
  const rows = await sql<{ day: Date; name: string; n: string }[]>`
    SELECT date_trunc('day', created_at)::date AS day, name, count(*) AS n FROM analytics_events
    WHERE created_at > now() - make_interval(days => ${d}) GROUP BY 1, 2 ORDER BY 1 DESC, 2`;
  return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), name: r.name, count: Number(r.n) }));
}
