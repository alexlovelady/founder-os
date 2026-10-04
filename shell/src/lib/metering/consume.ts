import { timingSafeEqual } from "node:crypto";
import type { Sql } from "@founderos/sdk";
import { HttpError } from "@founderos/sdk";
import { quotaFor } from "@/lib/tools/plan";

/**
 * Server-to-server metering for AI work done inside LegalAI's own pages. LegalAI calls POST /api/internal/quota/consume before it queues
 * a user-started AI job. The business is always resolved here from the user's own memberships; a caller can never name one.
 */

export const MIN_TOKEN_LEN = 32;
export const MAX_AMOUNT = 50;

/** The shared secret (INTERNAL_PROVISION_TOKEN). Empty when unset or too short: the endpoint then answers 404. */
export function internalToken(env: Record<string, string | undefined> = process.env): string {
  const t = (env.INTERNAL_PROVISION_TOKEN ?? "").trim();
  return t.length >= MIN_TOKEN_LEN ? t : "";
}

/** Constant-time comparison that does not leak the length of the expected token through timing of the content check. */
export function tokenMatches(sent: string | null | undefined, expected: string): boolean {
  if (!sent || !expected) return false;
  const a = Buffer.from(sent, "utf8");
  const b = Buffer.from(expected, "utf8");
  const same = a.length === b.length;
  // Compare against self when lengths differ so the work is the same either way.
  return timingSafeEqual(same ? a : b, b) && same;
}

export type ConsumeResult = { status: 200; body: { allowed: true; counted: boolean } } | { status: 402; body: { allowed: false; message: string } };

export interface ConsumeInput {
  userId: string;
  metric: string;
  amount?: number;
}

/** The business whose plan pays for this user's work: their oldest membership. Null for users with no shell business (standalone LegalAI users). */
export async function activeBusinessId(sql: Sql, userId: string): Promise<string | null> {
  const [r] = await sql<{ business_id: string }[]>`
    SELECT m.business_id FROM business_members m JOIN businesses b ON b.id = m.business_id
    WHERE m.user_id = ${userId} ORDER BY b.created_at, m.business_id LIMIT 1`;
  return r?.business_id ?? null;
}

/** Validate a request body. Throws HttpError(400) for anything unexpected (unknown fields, including any business id, are rejected). */
export function parseConsumeBody(raw: unknown): Required<ConsumeInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, "Invalid body");
  const o = raw as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !["userId", "metric", "amount"].includes(k));
  if (extra.length) throw new HttpError(400, "Unexpected field");
  if (typeof o.userId !== "string" || !o.userId || o.userId.length > 100) throw new HttpError(400, "userId is required");
  if (o.metric !== "ai_request") throw new HttpError(400, "Unsupported metric");
  const amount = o.amount === undefined ? 1 : o.amount;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) throw new HttpError(400, "Invalid amount");
  return { userId: o.userId, metric: "ai_request", amount };
}

/**
 * Count `amount` AI requests for the user's business with the same enforcement the tools use (`quotaFor`): with Stripe off it records and
 * allows, with Stripe on it enforces the plan and answers 402 with the plain message. Users without a business are allowed and not counted.
 */
export async function consumeForUser(sql: Sql, input: ConsumeInput): Promise<ConsumeResult> {
  const businessId = await activeBusinessId(sql, input.userId);
  if (!businessId) return { status: 200, body: { allowed: true, counted: false } };
  try {
    await quotaFor(sql, businessId, input.userId)(input.metric, input.amount ?? 1);
    return { status: 200, body: { allowed: true, counted: true } };
  } catch (e) {
    if (e instanceof HttpError && e.status === 402) return { status: 402, body: { allowed: false, message: e.message } };
    throw e;
  }
}
