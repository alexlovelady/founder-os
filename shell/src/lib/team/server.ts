import { cookies } from "next/headers";
import { getSession, type Session } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { planFor } from "@/lib/tools/plan";
import { ACTIVE_BUSINESS_COOKIE, resolveActiveBusinessId } from "./active";
import { getMembership, upsertProfile, type Sql } from "./members";
import type { Role } from "./permissions";

export interface TeamContext {
  sql: Sql;
  session: Session;
  businessId: string;
  /** The caller's role, read from the database for the verified session user. */
  role: Role;
}

/** Verified session + active business + membership. Refreshes the caller's profile row. Null when there is no session or no business. */
export async function teamContext(): Promise<TeamContext | null> {
  const session = await getSession();
  if (!session) return null;
  const sql = db();
  const jar = await cookies();
  const businessId = await resolveActiveBusinessId(sql, session.user.id, jar.get(ACTIVE_BUSINESS_COOKIE)?.value);
  if (!businessId) return null;
  const m = await getMembership(sql, businessId, session.user.id);
  if (!m) return null;
  await upsertProfile(sql, businessId, session.user).catch(() => {});
  return { sql, session, businessId, role: m.role };
}

/**
 * Seat limit for the business's plan. Billing is built separately: until the lead wires it, there is no limit.
 * Replace the body with the billing lookup (null = unlimited).
 */
export async function seatLimitFor(businessId: string): Promise<number | null> {
  const plan = await planFor(db(), businessId);
  return plan.limits.teamMembers ?? null;
}
