import type { Sql, ToolDef } from "./index";

/** Apply every tool's migrations once each, in name order. Safe to call on every start and from several instances at once. */
export async function runToolMigrations(sql: Sql, tools: ToolDef[]): Promise<string[]> {
  const applied: string[] = [];
  await sql`CREATE TABLE IF NOT EXISTS tool_migrations (tool text NOT NULL, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tool, name))`;
  for (const tool of tools) {
    const migrations = [...(tool.migrations ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const m of migrations) {
      await sql.begin(async (tx) => {
        // One migration at a time across instances.
        await tx`SELECT pg_advisory_xact_lock(hashtext('founderos-tool-migrations'))`;
        const [done] = await tx`SELECT 1 FROM tool_migrations WHERE tool = ${tool.id} AND name = ${m.name}`;
        if (done) return;
        await tx.unsafe(m.sql);
        await tx`INSERT INTO tool_migrations (tool, name) VALUES (${tool.id}, ${m.name})`;
        applied.push(`${tool.id}/${m.name}`);
      });
    }
  }
  return applied;
}
