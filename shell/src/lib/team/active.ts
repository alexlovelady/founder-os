import { db } from "@/lib/db";
import type { Sql } from "./members";

/** Cookie that remembers which of the user's businesses is active. Set by POST /api/team/active; read here. */
export const ACTIVE_BUSINESS_COOKIE = "fos_business";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pure-ish resolver: the cookie's business if the user is a member of it, otherwise their oldest business, otherwise null.
 * The cookie is a hint, never trusted: membership is always checked here.
 */
export async function resolveActiveBusinessId(sql: Sql, userId: string, cookieValue: string | null | undefined): Promise<string | null> {
  if (cookieValue && UUID.test(cookieValue)) {
    const [m] = await sql`SELECT 1 FROM business_members WHERE business_id = ${cookieValue} AND user_id = ${userId}`;
    if (m) return cookieValue;
  }
  const [first] = await sql<{ business_id: string }[]>`
    SELECT m.business_id FROM business_members m JOIN businesses b ON b.id = m.business_id
    WHERE m.user_id = ${userId} ORDER BY b.created_at, b.id LIMIT 1`;
  return first?.business_id ?? null;
}

/** For the lead to use inside currentBusiness(): pass `(await cookies()).get(ACTIVE_BUSINESS_COOKIE)?.value`. */
export function getActiveBusinessId(userId: string, cookieValue: string | null | undefined): Promise<string | null> {
  return resolveActiveBusinessId(db(), userId, cookieValue);
}
