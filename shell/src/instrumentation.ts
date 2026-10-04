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
  // operations jobs: verified database backup and error retention purge (docs/BACKUPS.md)
  const { registerJobs } = await import("./lib/notify/scheduler");
  const { OPS_JOBS } = await import("./lib/ops/jobs");
  registerJobs(OPS_JOBS);
  (await import("./lib/notify/scheduler")).startScheduler();
}

/**
 * Server errors (render, route handlers, server actions) land in error_events and, when SENTRY_DSN is set, in Sentry.
 * Only the route pattern is used (never the URL with its query string); headers and bodies are not read. Never throws.
 */
export async function onRequestError(err: unknown, request: { path: string; method: string }, context: { routePath?: string; routeType?: string }) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { captureError } = await import("./lib/ops/errors");
    await captureError(err, { route: context?.routePath || request?.path, method: request?.method, status: context?.routeType });
  } catch {
    /* an error reporter must not raise errors */
  }
}
