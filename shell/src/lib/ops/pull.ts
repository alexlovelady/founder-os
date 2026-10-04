import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { Sql } from "@founderos/sdk";
import { backupConfig, latestVerified, listBackupRuns } from "./backup";

/**
 * The off-site pull endpoints (mirror of LegalAI's /api/admin/backup/*): the owner's PC downloads the latest verified dump with a token that can do
 * nothing else. BACKUP_PULL_TOKEN is its own secret, NOT INTERNAL_PROVISION_TOKEN. Unset (or shorter than 32 characters) means the endpoints do not exist (404).
 */
export const MIN_TOKEN = 32;

export function pullTokenConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return (env.BACKUP_PULL_TOKEN ?? "").trim().length >= MIN_TOKEN;
}

/** Constant-time comparison (both sides hashed so lengths never leak). */
export function tokenMatches(given: string | null, env: Record<string, string | undefined> = process.env): boolean {
  const want = (env.BACKUP_PULL_TOKEN ?? "").trim();
  if (want.length < MIN_TOKEN || !given) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

const noStore = { "cache-control": "no-store" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: noStore });

/** Returns a Response to send instead (404 / 401), or null when the caller may proceed. */
export function gate(req: Request, env: Record<string, string | undefined> = process.env): Response | null {
  if (!pullTokenConfigured(env)) return json({ error: "Not found" }, 404);
  if (!tokenMatches(req.headers.get("x-internal-token"), env)) return json({ error: "Unauthorized" }, 401);
  return null;
}

export async function manifestResponse(sql: Sql, req: Request, env: Record<string, string | undefined> = process.env): Promise<Response> {
  const blocked = gate(req, env);
  if (blocked) return blocked;
  const cfg = backupConfig(env);
  if (!cfg.dir) return json({ configured: false, latest: null, backups: [] });
  const latest = await latestVerified(sql, cfg.dir);
  const runs = (await listBackupRuns(sql, 20)).filter((r) => r.verified && r.fileName);
  const view = (r: (typeof runs)[number]) => ({ name: r.fileName, size: r.sizeBytes, sha256: r.sha256, createdAt: r.createdAt, verified: r.verified, restoreVerified: r.restoreVerified, tables: Object.keys(r.tables).length, rowCounts: r.tables });
  return json({ configured: true, latest: latest ? view(latest.row) : null, backups: runs.map(view) });
}

/** Streams the newest verified dump that is still on disk. The sha256 recorded when it was verified is in a header for the puller to check. */
export async function latestResponse(sql: Sql, req: Request, env: Record<string, string | undefined> = process.env): Promise<Response> {
  const blocked = gate(req, env);
  if (blocked) return blocked;
  const cfg = backupConfig(env);
  if (!cfg.dir) return json({ error: "Backups are not configured" }, 503);
  const latest = await latestVerified(sql, cfg.dir);
  if (!latest || !latest.row.sha256) return json({ error: "No verified backup yet" }, 404);
  const size = statSync(latest.path).size;
  const body = Readable.toWeb(createReadStream(latest.path)) as unknown as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      ...noStore,
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "content-disposition": `attachment; filename="${latest.row.fileName}"`,
      "x-backup-sha256": latest.row.sha256,
      "x-backup-name": latest.row.fileName!,
      "x-backup-created-at": latest.row.createdAt,
    },
  });
}
