import type { Sql } from "@founderos/sdk";

/** Keys whose values are never stored in audit metadata (matched anywhere in the key name, case-insensitive). */
const SENSITIVE_KEY = /pass(word|wd|phrase)?|token|secret|key|authorization|cookie|credential|session|csrf|bearer|signature/i;
const MAX_STRING = 300;
const MAX_ARRAY = 20;
const MAX_KEYS = 30;
const MAX_DEPTH = 4;
const MAX_JSON = 4000;

/** Strip secret-looking keys, shorten long strings, cap depth/width. Pure. */
export function sanitizeMeta(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated]` : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[too deep]";
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((v) => sanitizeMeta(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY.test(k)) continue;
      out[k.slice(0, 80)] = sanitizeMeta(v, depth + 1);
    }
    return out;
  }
  return null; // functions, symbols
}

/** Sanitize and make sure the serialized size stays small. */
export function sanitizeAuditMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> {
  const clean = (sanitizeMeta(meta ?? {}) ?? {}) as Record<string, unknown>;
  const text = JSON.stringify(clean);
  if (text.length > MAX_JSON) return { truncated: true, keys: Object.keys(clean).slice(0, MAX_KEYS) };
  return clean;
}

export interface AuditInput {
  /** null/undefined for platform-level events (admin actions not tied to one business). */
  businessId?: string | null;
  userId?: string | null;
  action: string;
  resource?: { tool: string; id: string };
  meta?: Record<string, unknown>;
}

/** Record who did what. Never throws; a failure is logged without any payload. */
export async function recordAudit(sql: Sql, input: AuditInput): Promise<void> {
  try {
    const meta = sanitizeAuditMeta(input.meta);
    await sql`
      INSERT INTO audit_events (business_id, user_id, action, resource_tool, resource_id, meta)
      VALUES (${input.businessId ?? null}, ${input.userId ? input.userId.slice(0, 200) : null}, ${input.action.slice(0, 120)},
              ${input.resource?.tool.slice(0, 60) ?? null}, ${input.resource?.id.slice(0, 200) ?? null}, ${sql.json(meta as never)})`;
  } catch (e) {
    const err = e as { name?: string; code?: string };
    console.error("audit write failed", err.name ?? "Error", err.code ?? "");
  }
}

export interface AuditRow {
  id: number;
  businessId: string | null;
  userId: string | null;
  action: string;
  resourceTool: string | null;
  resourceId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

type Raw = { id: string; business_id: string | null; user_id: string | null; action: string; resource_tool: string | null; resource_id: string | null; meta: Record<string, unknown>; created_at: Date };
const toRow = (r: Raw): AuditRow => ({
  id: Number(r.id), businessId: r.business_id, userId: r.user_id, action: r.action, resourceTool: r.resource_tool, resourceId: r.resource_id,
  meta: r.meta, createdAt: r.created_at.toISOString(),
});

/** One business's audit trail, newest first. `before` is the id of the last row of the previous page. */
export async function listAudit(sql: Sql, businessId: string, opts: { limit?: number; before?: number } = {}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const before = opts.before && Number.isFinite(opts.before) ? opts.before : null;
  const rows = await sql<Raw[]>`
    SELECT id, business_id, user_id, action, resource_tool, resource_id, meta, created_at FROM audit_events
    WHERE business_id = ${businessId} AND (${before}::bigint IS NULL OR id < ${before}::bigint)
    ORDER BY id DESC LIMIT ${limit}`;
  return rows.map(toRow);
}

export interface AdminAuditFilter {
  businessId?: string;
  userId?: string;
  action?: string; // prefix match
  limit?: number;
  before?: number;
}

/** Platform-wide viewer for admins (filterable). Not tenant-scoped: callers must have verified admin access. */
export async function listAuditAdmin(sql: Sql, f: AdminAuditFilter = {}): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);
  const prefix = f.action ? `${f.action.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await sql<Raw[]>`
    SELECT id, business_id, user_id, action, resource_tool, resource_id, meta, created_at FROM audit_events
    WHERE (${f.businessId ?? null}::uuid IS NULL OR business_id = ${f.businessId ?? null}::uuid)
      AND (${f.userId ?? null}::text IS NULL OR user_id = ${f.userId ?? null})
      AND (${prefix}::text IS NULL OR action LIKE ${prefix})
      AND (${f.before ?? null}::bigint IS NULL OR id < ${f.before ?? null}::bigint)
    ORDER BY id DESC LIMIT ${limit}`;
  return rows.map(toRow);
}
