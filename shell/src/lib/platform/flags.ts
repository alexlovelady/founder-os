import { createHash } from "node:crypto";
import { z } from "zod";
import type { Sql } from "@founderos/sdk";

/** Deterministic bucket 0..99 for a business and flag: the same pair always lands in the same bucket, different flags bucket independently. */
export function rolloutBucket(businessId: string, key: string): number {
  const h = createHash("sha256").update(`${businessId}:${key}`).digest();
  return h.readUInt32BE(0) % 100;
}

/** Pure decision, used by isEnabled. */
export function decide(flag: { enabled: boolean; rolloutPct: number } | null, override: boolean | null, businessId: string, key: string): boolean {
  if (override !== null) return override;
  if (!flag || !flag.enabled) return false;
  if (flag.rolloutPct >= 100) return true;
  if (flag.rolloutPct <= 0) return false;
  return rolloutBucket(businessId, key) < flag.rolloutPct;
}

/** Is the flag on for this business? Override wins; unknown key = false; any database error = false. */
export async function isEnabled(sql: Sql, key: string, businessId: string): Promise<boolean> {
  try {
    const [row] = await sql<{ enabled: boolean; rollout_pct: number; override: boolean | null }[]>`
      SELECT f.enabled, f.rollout_pct, o.enabled AS override
      FROM feature_flags f LEFT JOIN feature_flag_overrides o ON o.key = f.key AND o.business_id = ${businessId}
      WHERE f.key = ${key}`;
    if (!row) return false;
    return decide({ enabled: row.enabled, rolloutPct: row.rollout_pct }, row.override, businessId, key);
  } catch {
    return false;
  }
}

/** All flags as seen by one business (for gating UI in one query). */
export async function flagsFor(sql: Sql, businessId: string): Promise<Record<string, boolean>> {
  const rows = await sql<{ key: string; enabled: boolean; rollout_pct: number; override: boolean | null }[]>`
    SELECT f.key, f.enabled, f.rollout_pct, o.enabled AS override
    FROM feature_flags f LEFT JOIN feature_flag_overrides o ON o.key = f.key AND o.business_id = ${businessId}`;
  return Object.fromEntries(rows.map((r) => [r.key, decide({ enabled: r.enabled, rolloutPct: r.rollout_pct }, r.override, businessId, r.key)]));
}

export const FlagKey = z.string().trim().min(2).max(60).regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, digits and underscores");
export const FlagInput = z.object({
  key: FlagKey,
  description: z.string().trim().max(300).default(""),
  enabled: z.boolean(),
  rolloutPct: z.number().int().min(0).max(100).default(100),
});
export type FlagInput = z.infer<typeof FlagInput>;

export const OverrideInput = z.object({ businessId: z.uuid(), key: FlagKey, enabled: z.boolean().nullable() });

export interface FlagRow {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPct: number;
  updatedBy: string | null;
  updatedAt: string;
  overrides: number;
}

export async function listFlags(sql: Sql): Promise<FlagRow[]> {
  const rows = await sql<{ key: string; description: string; enabled: boolean; rollout_pct: number; updated_by: string | null; updated_at: Date; overrides: string }[]>`
    SELECT f.key, f.description, f.enabled, f.rollout_pct, f.updated_by, f.updated_at,
           (SELECT count(*) FROM feature_flag_overrides o WHERE o.key = f.key) AS overrides
    FROM feature_flags f ORDER BY f.key`;
  return rows.map((r) => ({ key: r.key, description: r.description, enabled: r.enabled, rolloutPct: r.rollout_pct, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString(), overrides: Number(r.overrides) }));
}

export async function upsertFlag(sql: Sql, input: FlagInput, updatedBy: string): Promise<void> {
  await sql`
    INSERT INTO feature_flags (key, description, enabled, rollout_pct, updated_by, updated_at)
    VALUES (${input.key}, ${input.description}, ${input.enabled}, ${input.rolloutPct}, ${updatedBy}, now())
    ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, enabled = EXCLUDED.enabled, rollout_pct = EXCLUDED.rollout_pct,
      updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

/** enabled = null removes the override. Returns false when the flag or business does not exist. */
export async function setOverride(sql: Sql, businessId: string, key: string, enabled: boolean | null): Promise<boolean> {
  if (enabled === null) {
    await sql`DELETE FROM feature_flag_overrides WHERE business_id = ${businessId} AND key = ${key}`;
    return true;
  }
  const [b] = await sql`SELECT 1 FROM businesses WHERE id = ${businessId}`;
  const [f] = await sql`SELECT 1 FROM feature_flags WHERE key = ${key}`;
  if (!b || !f) return false;
  await sql`
    INSERT INTO feature_flag_overrides (business_id, key, enabled) VALUES (${businessId}, ${key}, ${enabled})
    ON CONFLICT (business_id, key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`;
  return true;
}
