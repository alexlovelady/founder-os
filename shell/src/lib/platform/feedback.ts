import { z } from "zod";
import type { Sql } from "@founderos/sdk";

export const FEEDBACK_KINDS = ["bug", "feature", "confusing", "other"] as const;
export const FEEDBACK_LIMIT_PER_HOUR = 10;

export const FeedbackInput = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  message: z.string().trim().min(1, "Write a short message").max(2000, "Keep it under 2000 characters"),
  page: z.string().max(500).optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;

export class RateLimitError extends Error {}

/** Keep only the path of the page (no query string or fragment, which can carry ids or tokens). Pure. */
export function cleanPage(page: string | undefined): string {
  if (!page) return "";
  const path = page.split(/[?#]/)[0] ?? "";
  return path.slice(0, 300);
}

export async function submitFeedback(
  sql: Sql,
  who: { userId: string; businessId: string | null },
  input: FeedbackInput,
  userAgent: string,
): Promise<number> {
  return sql.begin(async (tx) => {
    // Serialize one user's submissions so the in-database count cannot be raced past.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`feedback:${who.userId}`}))`;
    const [{ n }] = await tx<{ n: string }[]>`SELECT count(*) AS n FROM feedback WHERE user_id = ${who.userId} AND created_at > now() - interval '1 hour'`;
    if (Number(n) >= FEEDBACK_LIMIT_PER_HOUR) throw new RateLimitError("Too much feedback in the last hour. Please try again later.");
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO feedback (business_id, user_id, kind, message, page, user_agent)
      VALUES (${who.businessId}, ${who.userId}, ${input.kind}, ${input.message}, ${cleanPage(input.page)}, ${userAgent.slice(0, 300)})
      RETURNING id`;
    return Number(row.id);
  });
}

export interface FeedbackRow {
  id: number; businessId: string | null; userId: string; kind: string; message: string; page: string; userAgent: string; status: string; createdAt: string;
}

export async function listFeedback(sql: Sql, opts: { status?: "new" | "handled"; limit?: number } = {}): Promise<FeedbackRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await sql<{ id: string; business_id: string | null; user_id: string; kind: string; message: string; page: string; user_agent: string; status: string; created_at: Date }[]>`
    SELECT * FROM feedback WHERE (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null}) ORDER BY id DESC LIMIT ${limit}`;
  return rows.map((r) => ({ id: Number(r.id), businessId: r.business_id, userId: r.user_id, kind: r.kind, message: r.message, page: r.page, userAgent: r.user_agent, status: r.status, createdAt: r.created_at.toISOString() }));
}

export async function setFeedbackStatus(sql: Sql, id: number, status: "new" | "handled"): Promise<boolean> {
  const rows = await sql`UPDATE feedback SET status = ${status} WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
