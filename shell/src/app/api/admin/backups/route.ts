import { db } from "@/lib/db";
import { backupConfig, backupFreshness, listBackupRuns, runBackup } from "@/lib/ops/backup";
import { recordAudit } from "@/lib/platform/audit";
import { adminApi } from "@/lib/platform/http";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const a = await adminApi(req, { write: false });
  if ("response" in a) return a.response;
  const runs = await listBackupRuns(db());
  return Response.json({ configured: Boolean(backupConfig().dir), freshness: backupFreshness(Boolean(backupConfig().dir), runs), runs });
}

/** "Run backup now": a verified dump, audited. Takes the same lock as the scheduled job, so two never run at once. */
export async function POST(req: Request) {
  const a = await adminApi(req, { write: true });
  if ("response" in a) return a.response;
  const sql = db();
  const r = await runBackup(sql);
  await recordAudit(sql, { businessId: null, userId: a.session.user.id, action: "admin.backup.run", resource: { tool: "platform", id: r.file ?? "none" }, meta: { state: r.state, ok: r.ok } });
  return Response.json({ state: r.state, ok: r.ok, detail: r.detail }, { status: r.ok ? 200 : 500 });
}
