import { z } from "zod";
import type { Sql } from "@founderos/sdk";
import { recordAudit } from "./audit";
import { discoverTables, PLATFORM_PREFIXES } from "./tables";

const MAX_ROWS_PER_TABLE = 50000;

export const PrivacySettingsInput = z.object({
  aiDataUseNotes: z.string().trim().max(2000).default(""),
  allowProductAnalytics: z.boolean().default(true),
});
export type PrivacySettings = z.infer<typeof PrivacySettingsInput>;

export async function getPrivacySettings(sql: Sql, businessId: string): Promise<PrivacySettings> {
  const [row] = await sql<{ ai_data_use_notes: string; allow_product_analytics: boolean }[]>`
    SELECT ai_data_use_notes, allow_product_analytics FROM privacy_settings WHERE business_id = ${businessId}`;
  return row ? { aiDataUseNotes: row.ai_data_use_notes, allowProductAnalytics: row.allow_product_analytics } : { aiDataUseNotes: "", allowProductAnalytics: true };
}

export async function setPrivacySettings(sql: Sql, businessId: string, userId: string, input: PrivacySettings): Promise<PrivacySettings> {
  await sql`
    INSERT INTO privacy_settings (business_id, ai_data_use_notes, allow_product_analytics, updated_by)
    VALUES (${businessId}, ${input.aiDataUseNotes}, ${input.allowProductAnalytics}, ${userId})
    ON CONFLICT (business_id) DO UPDATE SET ai_data_use_notes = EXCLUDED.ai_data_use_notes, allow_product_analytics = EXCLUDED.allow_product_analytics,
      updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await recordAudit(sql, { businessId, userId, action: "privacy.settings.update", meta: { allowProductAnalytics: input.allowProductAnalytics } });
  return input;
}

export type Role = "owner" | "admin" | "member" | "viewer";

/** The caller's role in the business, or null when they are not a member. */
export async function memberRole(sql: Sql, userId: string, businessId: string): Promise<Role | null> {
  const [row] = await sql<{ role: Role }[]>`SELECT role FROM business_members WHERE business_id = ${businessId} AND user_id = ${userId}`;
  return row?.role ?? null;
}

export interface BusinessExport {
  exportedAt: string;
  format: "founderos-export-v1";
  notes: string[];
  business: Record<string, unknown> | null;
  members: Record<string, unknown>[];
  privacySettings: PrivacySettings;
  entityLinks: Record<string, unknown>[];
  tools: Record<string, Record<string, Record<string, unknown>[]>>;
  platform: Record<string, Record<string, unknown>[]>;
  /** Tables that exist for a tool but have no business_id column (cannot be exported by tenant). */
  skippedTables: string[];
  /** Columns left out (binary data, secrets); names only. */
  excludedColumns: Record<string, string[]>;
}

/**
 * Everything the product holds for one business, as plain JSON. Tool tables are discovered from the `<toolid>_*` naming rule and filtered
 * by business_id; binary columns (document bytes) and secret-like columns are left out. Pure with respect to `sql`.
 */
export async function exportBusinessData(sql: Sql, businessId: string, toolIds: string[]): Promise<BusinessExport> {
  const [business] = await sql`
    SELECT id, name, legal_name, description, entity_type, industry, country, state, city, website, lifecycle_stage, employee_count,
           operations, goals, created_at, updated_at FROM businesses WHERE id = ${businessId}`;
  const members = await sql`SELECT user_id, role, created_at FROM business_members WHERE business_id = ${businessId} ORDER BY created_at`;
  const entityLinks = await sql`SELECT from_tool, from_id, to_tool, to_id, kind, created_by, created_at FROM entity_links WHERE business_id = ${businessId}`;
  const auditRows = await sql`SELECT id, user_id, action, resource_tool, resource_id, meta, created_at FROM audit_events WHERE business_id = ${businessId} ORDER BY id DESC LIMIT 5000`;
  const feedbackRows = await sql`SELECT kind, message, page, status, created_at FROM feedback WHERE business_id = ${businessId} ORDER BY id`;
  const analyticsRows = await sql`SELECT name, props, created_at FROM analytics_events WHERE business_id = ${businessId} ORDER BY id DESC LIMIT 5000`;

  const tools: BusinessExport["tools"] = {};
  const platform: BusinessExport["platform"] = {};
  const skipped: string[] = [];
  const excludedColumns: Record<string, string[]> = {};

  const tables = await discoverTables(sql, [...toolIds, ...PLATFORM_PREFIXES]);
  for (const t of tables) {
    if (!t.hasBusinessId) { skipped.push(t.table); continue; }
    if (t.excluded.length) excludedColumns[t.table] = t.excluded;
    if (!t.columns.length) continue;
    const rows = await sql`SELECT ${sql(t.columns)} FROM ${sql(t.table)} WHERE business_id = ${businessId} LIMIT ${MAX_ROWS_PER_TABLE}`;
    const owner = toolIds.find((id) => t.table === id || t.table.startsWith(`${id}_`));
    if (owner) (tools[owner] ??= {})[t.table] = [...rows];
    else platform[t.table] = [...rows];
  }
  platform["audit_events"] = [...auditRows];
  platform["feedback"] = [...feedbackRows];
  platform["analytics_events"] = [...analyticsRows];

  return {
    exportedAt: new Date().toISOString(),
    format: "founderos-export-v1",
    notes: [
      "Uploaded document files are not inside this export (only their metadata). Download files from the Vault.",
      "Columns holding binary data or secrets (tokens, passwords, encrypted values) are omitted; see excludedColumns.",
      "LegalAI workspace data lives in the separate LegalAI service and is not part of this file.",
      "Audit, feedback and analytics lists are capped at 5000 most recent rows.",
    ],
    business: business ? { ...business } : null,
    members: [...members],
    privacySettings: await getPrivacySettings(sql, businessId),
    entityLinks: [...entityLinks],
    tools,
    platform,
    skippedTables: skipped,
    excludedColumns,
  };
}

export type DeleteResult = { ok: true } | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * Delete a business and, by cascade, every tool table row. Owner only, and the caller must type the business name exactly.
 * An audit event is written first (without the business name, and with business_id null so it survives the deletion); the business's
 * other audit rows are removed with it. Does NOT touch LegalAI (workspace data there must be removed in LegalAI).
 */
export async function deleteBusiness(sql: Sql, o: { businessId: string; userId: string; confirmName: string }): Promise<DeleteResult> {
  const role = await memberRole(sql, o.userId, o.businessId);
  if (!role) return { ok: false, status: 404, error: "Business not found" };
  if (role !== "owner") return { ok: false, status: 403, error: "Only the owner can delete the business" };
  const [b] = await sql<{ name: string }[]>`SELECT name FROM businesses WHERE id = ${o.businessId}`;
  if (!b) return { ok: false, status: 404, error: "Business not found" };
  if (o.confirmName.trim() !== b.name.trim()) return { ok: false, status: 400, error: "The name you typed does not match the business name" };
  await recordAudit(sql, { businessId: null, userId: o.userId, action: "privacy.business.delete", meta: { deletedBusinessId: o.businessId } });
  await sql.begin(async (tx) => {
    await tx`DELETE FROM audit_events WHERE business_id = ${o.businessId}`;
    await tx`DELETE FROM businesses WHERE id = ${o.businessId}`;
  });
  return { ok: true };
}
