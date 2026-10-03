// Runs once when the server starts: apply every tool's database migrations.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  const { runToolMigrations } = await import("@founderos/sdk/migrate");
  const { TOOLS } = await import("./lib/tools/registry");
  const { db } = await import("./lib/db");
  const applied = await runToolMigrations(db(), TOOLS);
  if (applied.length) console.log("tool migrations applied:", applied.join(", "));
}
