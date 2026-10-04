import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { backupConfig, backupFreshness, defaultRunner, latestVerified, listBackupFiles, listBackupRuns, pruneBackupFiles, runBackup, type BackupRunner } from "../../src/lib/ops/backup";
import { OPS_JOBS } from "../../src/lib/ops/jobs";
import { registerJobs, runDueJobs, EXTRA_JOBS } from "../../src/lib/notify/scheduler";

let env: TestEnv;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "shbk-")); dirs.push(d); return d; };
beforeAll(async () => { env = await makeTestEnv([]); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.sql`DELETE FROM shell_backups`; await env.sql`DELETE FROM scheduled_runs WHERE job IN ('shell_backup','error_purge')`; });
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const NOW = new Date("2026-10-04T03:00:00Z");
const fakeRunner = (over: Partial<BackupRunner> = {}): BackupRunner => ({
  available: async () => true,
  dump: async (_url, file) => { writeFileSync(file, "PGDMP-fake-archive"); return null; },
  list: async () => 12,
  restoreCounts: async () => ({}),
  ...over,
});

describe("config", () => {
  it("is unconfigured without BACKUP_DIR and defaults keep to 7", () => {
    expect(backupConfig({}).dir).toBeNull();
    expect(backupConfig({ BACKUP_DIR: "/data/backups" })).toMatchObject({ keep: 7, verifyRestore: false });
    expect(backupConfig({ BACKUP_DIR: "x", BACKUP_KEEP: "3", BACKUP_VERIFY_RESTORE: "1" })).toMatchObject({ keep: 3, verifyRestore: true });
    expect(backupConfig({ BACKUP_DIR: "x", BACKUP_KEEP: "0" }).keep).toBe(7);
  });
});

describe("runBackup states (injected runner)", () => {
  it("not configured when BACKUP_DIR is unset: says so, records no backup row", async () => {
    const r = await runBackup(env.sql, { env: { DATABASE_URL: "postgresql://x/y" }, runner: fakeRunner() });
    expect(r).toMatchObject({ state: "not_configured", ok: true });
    expect(r.detail).toMatch(/backups not configured/);
    expect(await listBackupRuns(env.sql)).toHaveLength(0);
  });

  it("not configured when pg_dump is missing", async () => {
    const r = await runBackup(env.sql, { env: { BACKUP_DIR: tmp(), DATABASE_URL: "postgresql://x/y" }, runner: fakeRunner({ available: async () => false }) });
    expect(r.state).toBe("not_configured");
    expect(r.detail).toMatch(/pg_dump is not installed/);
  });

  it("writes a verified dump, manifest, row, and prunes to BACKUP_KEEP", async () => {
    const dir = tmp();
    const e = { BACKUP_DIR: dir, BACKUP_KEEP: "2", DATABASE_URL: "postgresql://x/y" };
    for (let i = 1; i <= 3; i++) {
      const r = await runBackup(env.sql, { env: e, runner: fakeRunner(), now: new Date(`2026-10-0${i}T03:00:00Z`) });
      expect(r).toMatchObject({ state: "ok", ok: true });
    }
    expect(listBackupFiles(dir)).toEqual(["shell-20261003-030000.dump", "shell-20261002-030000.dump"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".part"))).toEqual([]);
    const manifest = JSON.parse(readFileSync(join(dir, "shell-20261003-030000.dump.json"), "utf8"));
    expect(manifest).toMatchObject({ verified: true, tocEntries: 12, size: 18 });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    const runs = await listBackupRuns(env.sql);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({ verified: true, fileName: "shell-20261003-030000.dump", sizeBytes: 18, error: null });
    expect(Object.keys(runs[0].tables).length).toBeGreaterThan(5);
    // the newest verified file still on disk is what the pull endpoint serves; the pruned oldest is not
    const latest = await latestVerified(env.sql, dir);
    expect(latest?.row.fileName).toBe("shell-20261003-030000.dump");
  });

  it("a failing pg_dump records an error row and leaves no file", async () => {
    const dir = tmp();
    const r = await runBackup(env.sql, { env: { BACKUP_DIR: dir, DATABASE_URL: "postgresql://x/y" }, runner: fakeRunner({ dump: async () => "pg_dump failed (exit 1): connection refused password=hunter2" }), now: NOW });
    expect(r).toMatchObject({ state: "failed", ok: false });
    expect(r.detail).not.toContain("hunter2");
    expect(readdirSync(dir)).toEqual([]);
    const [row] = await listBackupRuns(env.sql);
    expect(row).toMatchObject({ verified: false, fileName: null });
    expect(row.error).toMatch(/connection refused/);
  });

  it("an unreadable archive (list fails) is a failed run, not a backup", async () => {
    const dir = tmp();
    const r = await runBackup(env.sql, { env: { BACKUP_DIR: dir, DATABASE_URL: "postgresql://x/y" }, runner: fakeRunner({ list: async () => { throw new Error("pg_restore --list failed"); } }), now: NOW });
    expect(r.state).toBe("failed");
    expect(listBackupFiles(dir)).toEqual([]);
    expect(await latestVerified(env.sql, dir)).toBeNull();
  });

  it("a scratch restore mismatch keeps the file out of rotation", async () => {
    const dir = tmp();
    const r = await runBackup(env.sql, { env: { BACKUP_DIR: dir, BACKUP_VERIFY_RESTORE: "1", DATABASE_URL: "postgresql://x/y" }, runner: fakeRunner({ restoreCounts: async () => ({ businesses: 0 }) }), now: NOW });
    expect(r.state).toBe("failed");
    expect(r.detail).toMatch(/scratch restore check failed/);
    expect(listBackupFiles(dir)).toEqual([]);
    expect(readdirSync(dir).some((f) => f.endsWith(".FAILED"))).toBe(true);
  });

  it("two runs at once: the second is locked out", async () => {
    const dir = tmp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeRunner({ dump: async (_u, f) => { await gate; writeFileSync(f, "x"); return null; } });
    const e = { BACKUP_DIR: dir, DATABASE_URL: "postgresql://x/y" };
    const first = runBackup(env.sql, { env: e, runner: slow, now: NOW });
    await new Promise((r) => setTimeout(r, 300));
    const second = await runBackup(env.sql, { env: e, runner: fakeRunner(), now: NOW });
    expect(second.state).toBe("busy");
    release();
    expect((await first).state).toBe("ok");
  });
});

describe("scheduler job", () => {
  it("is registered once, runs daily, and records the result in scheduled_runs", async () => {
    registerJobs(OPS_JOBS);
    registerJobs(OPS_JOBS);
    expect(EXTRA_JOBS.filter((j) => j.name === "shell_backup")).toHaveLength(1);
    const dir = tmp();
    const deps = (now: Date) => ({ now, backup: { env: { BACKUP_DIR: dir, DATABASE_URL: "postgresql://x/y" }, runner: fakeRunner() } });
    const jobs = OPS_JOBS;
    const first = await runDueJobs(env.sql, deps(NOW), jobs);
    expect(first.ran).toEqual(["shell_backup", "error_purge", "lifecycle_cleanup"]);
    expect((await runDueJobs(env.sql, deps(new Date("2026-10-04T20:00:00Z")), jobs)).ran).toEqual([]);
    expect((await runDueJobs(env.sql, deps(new Date("2026-10-05T03:00:00Z")), jobs)).ran).toEqual(["shell_backup", "error_purge", "lifecycle_cleanup"]);
    const [run] = await env.sql<{ ok: boolean; detail: string }[]>`SELECT ok, detail FROM scheduled_runs WHERE job = 'shell_backup' ORDER BY id LIMIT 1`;
    expect(run.ok).toBe(true);
    expect(run.detail).toContain("shell-20261004-030000.dump");
  });

  it("records 'backups not configured' when there is no BACKUP_DIR", async () => {
    await runDueJobs(env.sql, { now: NOW, backup: { env: { DATABASE_URL: "postgresql://x/y" } } }, OPS_JOBS);
    const [run] = await env.sql<{ ok: boolean; detail: string }[]>`SELECT ok, detail FROM scheduled_runs WHERE job = 'shell_backup'`;
    expect(run.detail).toMatch(/backups not configured/);
  });
});

describe("freshness (the admin banner)", () => {
  const run = (hoursAgo: number, verified = true) => ({ verified, createdAt: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString() });
  it("not configured, none, stale, ok", () => {
    expect(backupFreshness(false, [run(1)], NOW).level).toBe("not_configured");
    expect(backupFreshness(true, [], NOW).level).toBe("none");
    expect(backupFreshness(true, [run(1, false)], NOW).level).toBe("none");
    expect(backupFreshness(true, [run(37)], NOW).level).toBe("stale");
    expect(backupFreshness(true, [run(1, false), run(35)], NOW).level).toBe("ok");
    expect(backupFreshness(true, [run(36)], NOW).level).toBe("ok");
  });
});

describe("pruneBackupFiles", () => {
  it("keeps the newest N and ignores other files", () => {
    const d = tmp();
    for (const n of ["shell-20261001-010000.dump", "shell-20261002-010000.dump", "shell-20261003-010000.dump", "notes.txt"]) writeFileSync(join(d, n), "x");
    expect(pruneBackupFiles(d, 1)).toEqual(["shell-20261002-010000.dump", "shell-20261001-010000.dump"]);
    expect(readdirSync(d).sort()).toEqual(["notes.txt", "shell-20261003-010000.dump"]);
  });
});

const docker = process.env.BACKUP_TEST_DOCKER ?? "legalai-db-1";
const haveDocker = spawnSync("docker", ["exec", docker, "pg_dump", "--version"]).status === 0;
describe.skipIf(!haveDocker)("one real run through the docker client", () => {
  it("dumps the test database, lists it, restores it into a scratch database and matches every table", async () => {
    const dir = tmp();
    const url = process.env.TEST_DATABASE_URL ?? "postgresql://legalai:legalai-dev@localhost:5442/founderos_test";
    const e = { BACKUP_DIR: dir, BACKUP_DOCKER: docker, BACKUP_VERIFY_RESTORE: "1", DATABASE_URL: url };
    const r = await runBackup(env.sql, { env: e, databaseUrl: url, runner: defaultRunner(backupConfig(e)) });
    expect(r.detail).not.toMatch(/failed/);
    expect(r).toMatchObject({ state: "ok", ok: true });
    const [row] = await listBackupRuns(env.sql);
    expect(row).toMatchObject({ verified: true, restoreVerified: true });
    expect(row.sizeBytes).toBeGreaterThan(1000);
    expect(existsSync(join(dir, row.fileName!))).toBe(true);
  }, 120_000);
});
