import type { Sql } from "@founderos/sdk";
import { discoverTables } from "./tables";
import { listAudit, type AuditRow } from "./audit";

/** Read-only platform queries for the admin portal. Callers must already have verified platform-admin access. Never selects row-level tool data. */

export interface ToolCount { table: string; rows: number }

/** Row counts per tool table (counts only, never contents). `toolIds` come from the tool registry. */
export async function toolRowCounts(sql: Sql, toolIds: string[], businessId?: string): Promise<ToolCount[]> {
  const out: ToolCount[] = [];
  for (const t of await discoverTables(sql, toolIds)) {
    if (businessId && !t.hasBusinessId) continue;
    const [r] = businessId
      ? await sql<{ n: string }[]>`SELECT count(*) AS n FROM ${sql(t.table)} WHERE business_id = ${businessId}`
      : await sql<{ n: string }[]>`SELECT count(*) AS n FROM ${sql(t.table)}`;
    out.push({ table: t.table, rows: Number(r.n) });
  }
  return out;
}

export interface Overview {
  users: number;
  businesses: number;
  auditLast7Days: number;
  newFeedback: number;
  analyticsLast7Days: number;
  toolRows: ToolCount[];
}

export async function adminOverview(sql: Sql, toolIds: string[]): Promise<Overview> {
  const [c] = await sql<{ users: string; businesses: string; audit: string; feedback: string; events: string }[]>`
    SELECT (SELECT count(DISTINCT user_id) FROM business_members) AS users,
           (SELECT count(*) FROM businesses) AS businesses,
           (SELECT count(*) FROM audit_events WHERE created_at > now() - interval '7 days') AS audit,
           (SELECT count(*) FROM feedback WHERE status = 'new') AS feedback,
           (SELECT count(*) FROM analytics_events WHERE created_at > now() - interval '7 days') AS events`;
  return {
    users: Number(c.users), businesses: Number(c.businesses), auditLast7Days: Number(c.audit), newFeedback: Number(c.feedback),
    analyticsLast7Days: Number(c.events), toolRows: await toolRowCounts(sql, toolIds),
  };
}

export interface AdminBusinessRow {
  id: string; name: string; ownerId: string | null; createdAt: string; members: number; plan: string | null;
}

/** Plan lookup is defensive: the `subscriptions` table is created by another service and may not exist or may name its columns differently. */
async function plansByBusiness(sql: Sql): Promise<Map<string, string>> {
  for (const col of ["plan_id", "plan", "tier"]) {
    try {
      const rows = await sql.unsafe<{ business_id: string; plan: string }[]>(`SELECT business_id::text AS business_id, ${col}::text AS plan FROM subscriptions`);
      return new Map(rows.map((r) => [r.business_id, r.plan]));
    } catch {
      /* table or column missing: try the next shape */
    }
  }
  return new Map();
}

export async function listBusinessesAdmin(sql: Sql, opts: { search?: string; limit?: number } = {}): Promise<AdminBusinessRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const q = opts.search?.trim() ? `%${opts.search.trim().replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await sql<{ id: string; name: string; owner_id: string | null; created_at: Date; members: string }[]>`
    SELECT b.id, b.name, b.created_at,
           (SELECT user_id FROM business_members m WHERE m.business_id = b.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) AS owner_id,
           (SELECT count(*) FROM business_members m WHERE m.business_id = b.id) AS members
    FROM businesses b WHERE (${q}::text IS NULL OR b.name ILIKE ${q}) ORDER BY b.created_at DESC LIMIT ${limit}`;
  const plans = await plansByBusiness(sql);
  return rows.map((r) => ({ id: r.id, name: r.name, ownerId: r.owner_id, createdAt: r.created_at.toISOString(), members: Number(r.members), plan: plans.get(r.id) ?? null }));
}

export interface AdminBusinessDetail {
  profile: Record<string, unknown>;
  members: { userId: string; role: string; createdAt: string }[];
  plan: string | null;
  counts: ToolCount[];
  audit: AuditRow[];
}

/** Profile, member list, row counts per tool table and recent audit. No document contents and no row-level tool data. */
export async function adminBusinessDetail(sql: Sql, businessId: string, toolIds: string[]): Promise<AdminBusinessDetail | null> {
  const [profile] = await sql`
    SELECT id, name, entity_type, industry, country, state, city, lifecycle_stage, employee_count, created_at, updated_at FROM businesses WHERE id = ${businessId}`;
  if (!profile) return null;
  const members = await sql<{ user_id: string; role: string; created_at: Date }[]>`SELECT user_id, role, created_at FROM business_members WHERE business_id = ${businessId} ORDER BY created_at`;
  return {
    profile: { ...profile },
    members: members.map((m) => ({ userId: m.user_id, role: m.role, createdAt: m.created_at.toISOString() })),
    plan: (await plansByBusiness(sql)).get(businessId) ?? null,
    counts: await toolRowCounts(sql, toolIds, businessId),
    audit: await listAudit(sql, businessId, { limit: 25 }),
  };
}
