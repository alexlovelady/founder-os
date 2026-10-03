import type { Sql, ToolDef } from "@founderos/sdk";
import { runReminderSweep } from "./automations";
import { generateBriefForBusiness, weekStartOf } from "./brief";
import { processOutbox, type EmailProvider } from "./email";
import { buildSystemContext } from "./system-context";

/**
 * Background jobs (spec 71). One interval timer per server process; every tick takes a Postgres advisory lock, so with several instances
 * only one runs the jobs, and each job is gated by its last run in scheduled_runs so it runs once per period no matter how many ticks fire.
 * Every job is idempotent: running it again (after a crash, a failed run or a duplicate) creates nothing twice.
 */
export interface JobDeps {
  now?: Date;
  provider?: EmailProvider;
  tools?: ToolDef[];
  /** Override "is email configured". Defaults to the provider's own flag. */
  emailEnabled?: boolean;
}

export interface JobDef {
  name: string;
  due(lastOkAt: Date | null, now: Date): boolean;
  run(sql: Sql, deps: JobDeps): Promise<{ ok: boolean; detail: string }>;
}

const RETRY_AFTER_FAILURE_MS = 30 * 60_000;
const businessIds = async (sql: Sql) => (await sql<{ id: string }[]>`SELECT id FROM businesses ORDER BY created_at`).map((r) => r.id);

export const JOBS: JobDef[] = [
  {
    name: "outbox",
    due: (lastOk, now) => !lastOk || now.getTime() - lastOk.getTime() >= 55 * 60_000,
    async run(sql, deps) {
      const r = await processOutbox(sql, { provider: deps.provider, now: deps.now });
      return { ok: true, detail: JSON.stringify(r) };
    },
  },
  {
    name: "reminder_sweep",
    due: (lastOk, now) => !lastOk || lastOk.toISOString().slice(0, 10) < now.toISOString().slice(0, 10),
    async run(sql, deps) {
      let automations = 0, reminders = 0, errors = 0;
      for (const id of await businessIds(sql)) {
        try {
          const ctx = await buildSystemContext(sql, id, deps.tools);
          if (!ctx) continue;
          const { attention } = await ctx.context();
          const r = await runReminderSweep(sql, id, attention, { now: deps.now, emailEnabled: deps.emailEnabled ?? deps.provider?.enabled });
          automations += r.automations;
          reminders += r.reminders;
        } catch {
          errors++;
          console.error("reminder sweep failed for business", id);
        }
      }
      return { ok: errors === 0, detail: JSON.stringify({ automations, reminders, errors }) };
    },
  },
  {
    name: "weekly_brief",
    due: (lastOk, now) => !lastOk || lastOk.toISOString().slice(0, 10) < weekStartOf(now),
    async run(sql, deps) {
      let created = 0, errors = 0;
      for (const id of await businessIds(sql)) {
        try {
          if (await generateBriefForBusiness(sql, id, { now: deps.now, tools: deps.tools, emailEnabled: deps.emailEnabled ?? deps.provider?.enabled })) created++;
        } catch {
          errors++;
          console.error("weekly brief failed for business", id);
        }
      }
      return { ok: errors === 0, detail: JSON.stringify({ created, errors }) };
    },
  },
];

/** Run whatever is due, if no other instance is already doing so. Returns the names of the jobs that ran (empty if locked or nothing due). */
export async function runDueJobs(sql: Sql, deps: JobDeps = {}, jobs: JobDef[] = JOBS): Promise<{ locked: boolean; ran: string[] }> {
  const now = deps.now ?? new Date();
  const ran: string[] = [];
  let locked = false;
  await sql.begin(async (tx) => {
    const [l] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('founderos-scheduler')) AS ok`;
    if (!l.ok) {
      locked = true;
      return;
    }
    for (const job of jobs) {
      const [last] = await sql<{ ran_at: Date; ok: boolean }[]>`SELECT ran_at, ok FROM scheduled_runs WHERE job = ${job.name} ORDER BY ran_at DESC, id DESC LIMIT 1`;
      const [lastOk] = await sql<{ ran_at: Date }[]>`SELECT ran_at FROM scheduled_runs WHERE job = ${job.name} AND ok ORDER BY ran_at DESC, id DESC LIMIT 1`;
      if (last && !last.ok && now.getTime() - last.ran_at.getTime() < RETRY_AFTER_FAILURE_MS) continue;
      if (!job.due(lastOk?.ran_at ?? null, now)) continue;
      let r: { ok: boolean; detail: string };
      try {
        r = await job.run(sql, deps);
      } catch (e) {
        r = { ok: false, detail: `error: ${(e as Error).message}`.slice(0, 300) };
        console.error("scheduled job failed:", job.name);
      }
      await sql`INSERT INTO scheduled_runs (job, ran_at, ok, detail) VALUES (${job.name}, ${now}, ${r.ok}, ${r.detail})`;
      ran.push(job.name);
    }
  });
  return { locked, ran };
}

declare global {
  var __founderosScheduler: ReturnType<typeof setInterval> | undefined;
}

/** Start the background scheduler once per process. Never during `next build`, never twice, and not when SCHEDULER_DISABLED=1. */
export function startScheduler(): boolean {
  if (globalThis.__founderosScheduler) return false;
  if (process.env.NEXT_PHASE === "phase-production-build") return false;
  if (process.env.SCHEDULER_DISABLED === "1" || !process.env.DATABASE_URL) return false;
  const every = Math.max(Number(process.env.SCHEDULER_TICK_MS) || 10 * 60_000, 1000);
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const { db } = await import("../db");
      const { getEmailProvider } = await import("./email");
      await runDueJobs(db(), { provider: getEmailProvider() });
    } catch {
      console.error("scheduler tick failed");
    } finally {
      busy = false;
    }
  };
  globalThis.__founderosScheduler = setInterval(tick, every);
  globalThis.__founderosScheduler.unref?.();
  setTimeout(tick, 20_000).unref?.();
  return true;
}
