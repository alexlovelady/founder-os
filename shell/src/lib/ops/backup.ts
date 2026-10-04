import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join, resolve } from "node:path";
import postgres from "postgres";
import type { Sql } from "@founderos/sdk";
import { log } from "./log";
import { sanitizeText } from "./sanitize";

/**
 * Scheduled, verified backups of the shell database. The same logic as shell/scripts/backup-lib.mjs + backup-shell.mjs (which stay in place and
 * keep working on their own); this copy is TypeScript so the Next server bundle imports it cleanly. Both are tested.
 * An unverified backup is not a backup: every dump is checked with `pg_restore --list`, and optionally restored into a scratch database whose
 * row counts are compared with the source (BACKUP_VERIFY_RESTORE=1).
 */

// ---------- helpers copied from scripts/backup-lib.mjs ----------
export function parseDbUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("DATABASE_URL must start with postgresql://");
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), host: u.hostname, port: u.port || "5432", database: decodeURIComponent(u.pathname.replace(/^\//, "")) };
}

export function withDatabase(raw: string, database: string): string {
  const u = new URL(raw);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

export interface Cmd { cmd: string; args: string[]; env: NodeJS.ProcessEnv }
export interface Tools {
  dump(url: string, extra?: string[]): Cmd;
  restore(url: string, extra?: string[]): Cmd;
  bare(tool: "pg_dump" | "pg_restore", extra: string[]): Cmd;
}

export function makeTools({ docker, pgDump = process.env.PG_DUMP || "pg_dump", pgRestore = process.env.PG_RESTORE || "pg_restore", dockerPort = "5432" }: { docker?: string; pgDump?: string; pgRestore?: string; dockerPort?: string } = {}): Tools {
  const bin = (tool: string) => (tool === "pg_dump" ? pgDump : pgRestore);
  const command = (tool: string, url: string, extra: string[]): Cmd => {
    if (!docker) return { cmd: bin(tool), args: [...extra, "--dbname", url], env: process.env };
    const d = parseDbUrl(url);
    return { cmd: "docker", args: ["exec", "-i", ...(d.password ? ["-e", `PGPASSWORD=${d.password}`] : []), docker, tool, ...extra, "-h", "localhost", "-p", dockerPort, "-U", d.user, "-d", d.database], env: process.env };
  };
  return {
    dump: (url, extra = []) => command("pg_dump", url, extra),
    restore: (url, extra = []) => command("pg_restore", url, extra),
    bare: (tool, extra) => (docker ? { cmd: "docker", args: ["exec", "-i", docker, tool, ...extra], env: process.env } : { cmd: bin(tool), args: extra, env: process.env }),
  };
}

export async function run({ cmd, args, env }: Cmd, opts: { stdinFile?: string; stdoutFile?: string; collectStdout?: boolean } = {}): Promise<{ code: number | null; stderr: string; stdout: string }> {
  const { stdinFile, stdoutFile, collectStdout = false } = opts;
  const child = spawn(cmd, args, { env, stdio: [stdinFile ? "pipe" : "ignore", stdoutFile || collectStdout ? "pipe" : "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  let stdout = "";
  const done: Promise<unknown>[] = [once(child, "close")];
  child.on("error", () => {});
  if (stdoutFile) {
    const out = createWriteStream(stdoutFile);
    child.stdout!.pipe(out);
    done.push(once(out, "finish"));
  } else if (collectStdout) {
    child.stdout!.on("data", (d) => (stdout += d));
  }
  if (stdinFile) {
    const inp = createReadStream(stdinFile);
    inp.on("error", () => child.stdin!.destroy());
    child.stdin!.on("error", () => {});
    inp.pipe(child.stdin!);
  }
  try {
    const [[code]] = (await Promise.all(done)) as [[number | null], ...unknown[]];
    return { code, stderr: stderr.trim(), stdout };
  } catch (e) {
    return { code: -1, stderr: `${cmd}: ${(e as Error).message}`, stdout };
  }
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

export async function listDump(tools: Tools, file: string): Promise<{ entries: number }> {
  const r = await run(tools.bare("pg_restore", ["--list"]), { stdinFile: file, collectStdout: true });
  if (r.code !== 0) throw new Error(`pg_restore --list failed (exit ${r.code}): ${r.stderr.split("\n").slice(-3).join(" | ")}`);
  const entries = r.stdout.split("\n").filter((l) => l.trim() && !l.startsWith(";")).length;
  if (entries === 0) throw new Error("pg_restore --list returned no entries: the dump is empty");
  return { entries };
}

export async function countTables(sql: Sql): Promise<Record<string, number>> {
  const tables = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [{ n }] = await sql.unsafe(`SELECT count(*)::bigint AS n FROM "${table_name.replaceAll('"', '""')}"`);
    out[table_name] = Number(n);
  }
  return out;
}

export async function restoreIntoScratch(tools: Tools, adminUrl: string, file: string): Promise<Record<string, number>> {
  const name = `founderos_restore_check_${randomBytes(4).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const scratchUrl = withDatabase(adminUrl, name);
  let scratch: ReturnType<typeof postgres> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const r = await run(tools.restore(scratchUrl, ["--no-owner", "--no-privileges", "--exit-on-error"]), { stdinFile: file });
    if (r.code !== 0) throw new Error(`pg_restore into scratch database failed (exit ${r.code}): ${r.stderr.split("\n").slice(-4).join(" | ")}`);
    scratch = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    return await countTables(scratch);
  } finally {
    if (scratch) await scratch.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
}

export type CountRange = number | { min: number; max: number };
export function compareCounts(expected: Record<string, CountRange>, actual: Record<string, number>): string[] {
  const problems: string[] = [];
  for (const [t, e] of Object.entries(expected)) {
    const min = typeof e === "number" ? e : e.min;
    const max = typeof e === "number" ? e : e.max;
    if (!(t in actual)) problems.push(`table ${t} is missing from the restore`);
    else if (actual[t] < min || actual[t] > max) problems.push(`table ${t}: restored ${actual[t]} rows, expected ${min === max ? min : `${min}-${max}`}`);
  }
  for (const t of Object.keys(actual)) if (!(t in expected)) problems.push(`table ${t} exists in the restore but not in the source`);
  return problems;
}

// ---------- files ----------
export const FILE_RE = /^shell-\d{8}-\d{6}\.dump$/;
export const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");

export function listBackupFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => FILE_RE.test(f)).sort().reverse() : [];
}

export function pruneBackupFiles(dir: string, keep: number): string[] {
  const removed: string[] = [];
  for (const f of listBackupFiles(dir).slice(keep)) {
    rmSync(join(dir, f), { force: true });
    rmSync(join(dir, `${f}.json`), { force: true });
    removed.push(f);
  }
  return removed;
}

// ---------- configuration ----------
export interface BackupConfig {
  dir: string | null;
  keep: number;
  verifyRestore: boolean;
  docker: string | undefined;
}

/** BACKUP_DIR unset means "not configured" (the scheduler and the admin page say so). The volume default /data/backups is documented, not assumed. */
export function backupConfig(env: Record<string, string | undefined> = process.env): BackupConfig {
  const keep = Number(env.BACKUP_KEEP);
  return {
    dir: env.BACKUP_DIR?.trim() ? resolve(env.BACKUP_DIR.trim()) : null,
    keep: Number.isInteger(keep) && keep >= 1 ? keep : 7,
    verifyRestore: env.BACKUP_VERIFY_RESTORE === "1",
    docker: env.BACKUP_DOCKER?.trim() || undefined,
  };
}

export const DEFAULT_BACKUP_DIR = "/data/backups";

export async function pgDumpAvailable(tools: Tools): Promise<boolean> {
  const r = await run(tools.bare("pg_dump", ["--version"]), { collectStdout: true });
  return r.code === 0;
}

// ---------- the job ----------
export interface BackupRunner {
  /** Is pg_dump usable here? */
  available(): Promise<boolean>;
  /** Dump the database to `file` in custom format; resolve with an error text or null. */
  dump(url: string, file: string): Promise<string | null>;
  list(file: string): Promise<number>;
  restoreCounts(url: string, file: string): Promise<Record<string, number>>;
}

export function defaultRunner(config: BackupConfig): BackupRunner {
  const tools = makeTools({ docker: config.docker });
  return {
    available: () => pgDumpAvailable(tools),
    async dump(url, file) {
      const d = await run(tools.dump(url, ["-Fc", "--no-owner", "--no-privileges"]), { stdoutFile: file });
      return d.code === 0 ? null : `pg_dump failed (exit ${d.code}): ${d.stderr.split("\n").slice(-4).join(" | ")}`;
    },
    list: async (file) => (await listDump(tools, file)).entries,
    restoreCounts: (url, file) => restoreIntoScratch(tools, url, file),
  };
}

export type BackupState = "not_configured" | "ok" | "failed" | "busy";
export interface BackupResult {
  state: BackupState;
  ok: boolean;
  detail: string;
  id?: number;
  file?: string;
}

export interface RunBackupOpts {
  env?: Record<string, string | undefined>;
  runner?: BackupRunner;
  databaseUrl?: string;
  now?: Date;
}

export const NOT_CONFIGURED_DETAIL = "backups not configured: attach a volume at /data and set BACKUP_DIR=/data/backups (see docs/BACKUPS.md)";

/**
 * One verified backup. Takes an advisory lock so a manual run and the scheduler (or two instances) never dump at once.
 * Records a shell_backups row for every attempt (success or failure) except "not configured", which only returns a result.
 */
export async function runBackup(sql: Sql, opts: RunBackupOpts = {}): Promise<BackupResult> {
  const env = opts.env ?? process.env;
  const cfg = backupConfig(env);
  if (!cfg.dir) return { state: "not_configured", ok: true, detail: NOT_CONFIGURED_DETAIL };
  const runner = opts.runner ?? defaultRunner(cfg);
  if (!(await runner.available())) return { state: "not_configured", ok: true, detail: "backups not configured: pg_dump is not installed in this container (the PGDG postgresql-client-16 is added by shell/Dockerfile; see docs/BACKUPS.md)" };
  const url = opts.databaseUrl ?? env.DATABASE_URL;
  if (!url) return { state: "failed", ok: false, detail: "DATABASE_URL is not set" };

  let result: BackupResult = { state: "busy", ok: true, detail: "another backup is already running" };
  await sql.begin(async (tx) => {
    const [l] = await tx<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock(hashtext('founderos-shell-backup')) AS ok`;
    if (!l.ok) return;
    result = await doBackup(sql, cfg, runner, url, opts.now ?? new Date());
  });
  return result;
}

async function doBackup(sql: Sql, cfg: BackupConfig, runner: BackupRunner, url: string, now: Date): Promise<BackupResult> {
  const dir = cfg.dir!;
  mkdirSync(dir, { recursive: true });
  const name = `shell-${stamp(now)}.dump`;
  const final = join(dir, name);
  const part = `${final}.part`;
  const fail = async (message: string, extra: { size?: number; sha?: string; tables?: object } = {}): Promise<BackupResult> => {
    rmSync(part, { force: true });
    const error = sanitizeText(message, 1000);
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO shell_backups (file_name, size_bytes, sha256, tables, verified, restore_verified, created_at, error)
      VALUES (${null}, ${extra.size ?? null}, ${extra.sha ?? null}, ${sql.json((extra.tables ?? {}) as never)}, false, ${null}, ${now}, ${error}) RETURNING id`;
    log("error", "backup_failed", { job: "shell_backup", error });
    return { state: "failed", ok: false, detail: error, id: Number(row.id) };
  };
  try {
    const before = await countTables(sql);
    const err = await runner.dump(url, part);
    if (err) return await fail(err);
    const after = await countTables(sql);
    const size = statSync(part).size;
    if (size === 0) return await fail("pg_dump produced an empty file");
    const sha = await sha256File(part);
    const entries = await runner.list(part);
    let restoreVerified: boolean | null = null;
    if (cfg.verifyRestore) {
      const ranges = Object.fromEntries(Object.keys(after).map((t) => [t, { min: Math.min(before[t] ?? 0, after[t]), max: Math.max(before[t] ?? 0, after[t]) }]));
      const problems = compareCounts(ranges, await runner.restoreCounts(url, part));
      if (problems.length) {
        renameSync(part, `${final}.FAILED`);
        return await fail(`scratch restore check failed: ${problems.slice(0, 4).join("; ")}`, { size, sha, tables: after });
      }
      restoreVerified = true;
    }
    renameSync(part, final);
    const manifest = { file: name, createdAt: now.toISOString(), size, sha256: sha, rowCounts: after, tocEntries: entries, verified: true, restoreVerified };
    writeFileSync(`${final}.json`, JSON.stringify(manifest, null, 2));
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO shell_backups (file_name, size_bytes, sha256, tables, verified, restore_verified, created_at)
      VALUES (${name}, ${size}, ${sha}, ${sql.json(after as never)}, true, ${restoreVerified}, ${now}) RETURNING id`;
    const pruned = pruneBackupFiles(dir, cfg.keep);
    log("info", "backup_ok", { job: "shell_backup", file: name, sizeBytes: size, verified: true, restoreVerified, tables: Object.keys(after).length, pruned: pruned.length });
    return { state: "ok", ok: true, detail: JSON.stringify({ file: name, sizeBytes: size, tables: Object.keys(after).length, restoreVerified, pruned: pruned.length }), id: Number(row.id), file: name };
  } catch (e) {
    return await fail((e as Error).message);
  }
}

// ---------- status ----------
export const STALE_AFTER_HOURS = 36;

export interface BackupRow {
  id: number;
  fileName: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  tables: Record<string, number>;
  verified: boolean;
  restoreVerified: boolean | null;
  createdAt: string;
  error: string | null;
}

export async function listBackupRuns(sql: Sql, limit = 50): Promise<BackupRow[]> {
  const rows = await sql<{ id: string; file_name: string | null; size_bytes: string | null; sha256: string | null; tables: Record<string, number>; verified: boolean; restore_verified: boolean | null; created_at: Date; error: string | null }[]>`
    SELECT id, file_name, size_bytes, sha256, tables, verified, restore_verified, created_at, error FROM shell_backups ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return rows.map((r) => ({ id: Number(r.id), fileName: r.file_name, sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes), sha256: r.sha256, tables: r.tables, verified: r.verified, restoreVerified: r.restore_verified, createdAt: r.created_at.toISOString(), error: r.error }));
}

export type Freshness = { level: "not_configured" } | { level: "none" } | { level: "stale"; ageHours: number } | { level: "ok"; ageHours: number };

/** Pure: is the newest verified backup recent enough? `runs` newest first. */
export function backupFreshness(configured: boolean, runs: Pick<BackupRow, "verified" | "createdAt">[], now = new Date(), maxHours = STALE_AFTER_HOURS): Freshness {
  if (!configured) return { level: "not_configured" };
  const newest = runs.find((r) => r.verified);
  if (!newest) return { level: "none" };
  const ageHours = (now.getTime() - new Date(newest.createdAt).getTime()) / 3_600_000;
  return ageHours > maxHours ? { level: "stale", ageHours } : { level: "ok", ageHours };
}

/** The newest verified backup whose file is still on disk, with its path. */
export async function latestVerified(sql: Sql, dir: string): Promise<{ row: BackupRow; path: string } | null> {
  for (const row of await listBackupRuns(sql, 20)) {
    if (!row.verified || !row.fileName || !FILE_RE.test(row.fileName)) continue;
    const path = join(dir, row.fileName);
    if (existsSync(path)) return { row, path };
  }
  return null;
}
