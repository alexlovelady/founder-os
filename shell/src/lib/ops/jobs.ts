import type { JobDef } from "../notify/scheduler";
import { runBackup } from "./backup";
import { purgeOldErrors } from "./errors";
import { purgeUnverified } from "../lifecycle/verify";
import { pruneLifecycle } from "../lifecycle/limits";

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Operations jobs, registered with the scheduler from instrumentation.ts (registerJobs). Both are daily in UTC and gated by scheduled_runs like the others.
 * - shell_backup: verified pg_dump to BACKUP_DIR. When backups are not configured it records "backups not configured" (ok) so the run history says why.
 * - error_purge: forget error groups not seen for 90 days.
 */
export const OPS_JOBS: JobDef[] = [
  {
    name: "shell_backup",
    due: (lastOk, now) => !lastOk || day(lastOk) < day(now),
    async run(sql, deps) {
      const r = await runBackup(sql, { now: deps.now, ...(deps.backup ?? {}) });
      return { ok: r.ok, detail: r.detail };
    },
  },
  {
    name: "error_purge",
    due: (lastOk, now) => !lastOk || day(lastOk) < day(now),
    async run(sql, deps) {
      const purged = await purgeOldErrors(sql, deps.now);
      return { ok: true, detail: JSON.stringify({ purged }) };
    },
  },
  {
    // Unconfirmed signups older than 7 days are deleted; used and expired lifecycle tokens and finished lifecycle mail are pruned.
    name: "lifecycle_cleanup",
    due: (lastOk, now) => !lastOk || day(lastOk) < day(now),
    async run(sql) {
      const r = await purgeUnverified(sql, {});
      await pruneLifecycle(sql);
      return { ok: true, detail: JSON.stringify(r) };
    },
  },
];
