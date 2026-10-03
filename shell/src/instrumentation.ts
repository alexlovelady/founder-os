// Runs once when the server starts: apply every tool's database migrations.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  const { runToolMigrations } = await import("@founderos/sdk/migrate");
  const { TOOLS } = await import("./lib/tools/registry");
  const { db } = await import("./lib/db");
  const applied = await runToolMigrations(db(), TOOLS);
  if (applied.length) console.log("tool migrations applied:", applied.join(", "));
  // notifications scheduler (outbox, daily reminders, weekly brief); guarded against double start and `next build`
  const { setBriefEnabledHook } = await import("./lib/notify/hooks");
  const { planFor } = await import("./lib/tools/plan");
  setBriefEnabledHook(async (businessId) => (await planFor(db(), businessId)).features.weeklyBrief !== false);
  (await import("./lib/notify/scheduler")).startScheduler();
}
