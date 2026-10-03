import type { Sql } from "@founderos/sdk";

/** Column names never exported or shown (secrets). */
export const SECRET_COLUMN = /token|secret|password|encrypted/i;
/** Column types never exported (binary blobs and types JSON cannot represent well, e.g. vectors). */
const SKIP_TYPES = new Set(["bytea", "USER-DEFINED"]);

export interface TableInfo {
  table: string;
  /** Columns that are safe to export. */
  columns: string[];
  /** Columns left out and why (names only). */
  excluded: string[];
  hasBusinessId: boolean;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Prefixes owned by platform services other than tools (their data also belongs in an export). */
export const PLATFORM_PREFIXES = ["notifications", "billing", "team", "subscriptions", "usage"];

/** Does `table` belong to one of the prefixes (exactly the prefix, or prefix + "_...")? Pure. */
export function matchesPrefix(table: string, prefixes: string[]): boolean {
  return prefixes.some((p) => table === p || table.startsWith(`${p}_`));
}

/** Discover tables (public schema) belonging to the given prefixes, with their exportable columns. */
export async function discoverTables(sql: Sql, prefixes: string[]): Promise<TableInfo[]> {
  const rows = await sql<{ table_name: string; column_name: string; data_type: string }[]>`
    SELECT c.table_name, c.column_name, c.data_type
    FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position`;
  const byTable = new Map<string, TableInfo>();
  for (const r of rows) {
    if (!IDENT.test(r.table_name) || !matchesPrefix(r.table_name, prefixes)) continue;
    let t = byTable.get(r.table_name);
    if (!t) byTable.set(r.table_name, (t = { table: r.table_name, columns: [], excluded: [], hasBusinessId: false }));
    if (r.column_name === "business_id") t.hasBusinessId = true;
    if (!IDENT.test(r.column_name) || SECRET_COLUMN.test(r.column_name) || SKIP_TYPES.has(r.data_type)) t.excluded.push(r.column_name);
    else t.columns.push(r.column_name);
  }
  return [...byTable.values()];
}
