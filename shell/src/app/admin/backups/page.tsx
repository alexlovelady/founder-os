import { db } from "@/lib/db";
import { backupConfig, backupFreshness, listBackupRuns, STALE_AFTER_HOURS } from "@/lib/ops/backup";
import { pullTokenConfigured } from "@/lib/ops/pull";
import { requireAdminPage } from "@/lib/platform/http";
import RunBackupButton from "./RunBackupButton";

export const dynamic = "force-dynamic";

const size = (n: number | null) => (n === null ? "" : n > 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`);

export default async function AdminBackups() {
  await requireAdminPage();
  const cfg = backupConfig();
  const runs = await listBackupRuns(db());
  const fresh = backupFreshness(Boolean(cfg.dir), runs);
  return (
    <>
      <h1 className="text-2xl font-semibold">Database backups</h1>
      {fresh.level !== "ok" && (
        <div role="alert" className="rounded-xl border border-red-700 bg-red-950 p-4 text-sm text-red-100">
          <p className="font-semibold">
            {fresh.level === "not_configured" && "Backups are not configured: this database has no backup."}
            {fresh.level === "none" && "No verified backup exists yet."}
            {fresh.level === "stale" && `The newest verified backup is ${Math.round(fresh.ageHours)} hours old (limit ${STALE_AFTER_HOURS}).`}
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>Railway, <code>shell</code> service, Settings, Volumes: add a volume mounted at <code>/data</code>.</li>
            <li>Variables on <code>shell</code>: <code>BACKUP_DIR=/data/backups</code>, optional <code>BACKUP_KEEP=7</code> and <code>BACKUP_VERIFY_RESTORE=1</code>, and <code>BACKUP_PULL_TOKEN</code> (32+ random characters) for the off-site copy.</li>
            <li>Redeploy. The job runs daily (UTC); press Run backup now to take the first one. The image contains <code>pg_dump</code> (PGDG postgresql-client-16).</li>
            <li>Run <code>shell/scripts/pull-shell-backup.mjs</code> on your PC daily so a copy exists outside Railway. Full steps and the restore drill: docs/BACKUPS.md.</li>
          </ol>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-300">
        <RunBackupButton disabled={!cfg.dir} />
        <span>Folder: <code>{cfg.dir ?? "BACKUP_DIR not set"}</code></span>
        <span>Keep: {cfg.keep}</span>
        <span>Scratch restore check: {cfg.verifyRestore ? "on" : "off (BACKUP_VERIFY_RESTORE=1 to enable)"}</span>
        <span>Off-site pull token: {pullTokenConfigured() ? "set" : <span className="text-amber-300">not set (BACKUP_PULL_TOKEN)</span>}</span>
      </div>
      <p className="text-xs text-slate-500">Verified means <code>pg_restore --list</code> read the whole archive{cfg.verifyRestore ? " and a scratch restore matched every table row count" : ""}. Backups on the volume do not survive losing the Railway project: pull a copy to your PC.</p>
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-900 text-xs text-slate-400"><tr><th className="p-2">When (UTC)</th><th className="p-2">File</th><th className="p-2">Size</th><th className="p-2">Tables</th><th className="p-2">Verified</th><th className="p-2">sha256</th><th className="p-2">Error</th></tr></thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-slate-800 align-top">
                <td className="whitespace-nowrap p-2">{r.createdAt.slice(0, 16).replace("T", " ")}</td>
                <td className="p-2 font-mono text-xs">{r.fileName ?? "-"}</td>
                <td className="p-2">{size(r.sizeBytes)}</td>
                <td className="p-2">{Object.keys(r.tables).length || ""}</td>
                <td className={`p-2 ${r.verified ? "text-emerald-400" : "text-red-400"}`}>{r.verified ? (r.restoreVerified ? "list + restore" : "list") : "FAILED"}</td>
                <td className="p-2 font-mono text-xs">{r.sha256?.slice(0, 12)}</td>
                <td className="p-2 text-xs text-red-300">{r.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {runs.length === 0 && <p className="p-4 text-sm text-slate-400">No backup has run yet.</p>}
      </div>
    </>
  );
}
