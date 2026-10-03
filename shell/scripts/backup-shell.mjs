#!/usr/bin/env node
// Verified backup of the shell database (build spec 92).
//
//   node shell/scripts/backup-shell.mjs --out backups/shell [--keep 14] [--verify-restore] [--docker <container>]
//
// 1. pg_dump in custom format (compressed) of DATABASE_URL to <out>/shell-YYYYmmdd-HHMMSS.dump
// 2. `pg_restore --list` on the file (proves the archive is readable end to end)
// 3. with --verify-restore: restore into a scratch database on the same server, compare every table's row count, drop it
// 4. write <file>.json (sha256, size, row counts, verdicts), then keep only the newest --keep dumps
// Exit code 0 only when every step passed. The password is never printed.
//
// Where the client tools run: on this machine (needs postgresql-client; set PG_DUMP / PG_RESTORE for non-PATH locations),
// or inside a container with --docker <name> (a laptop with Postgres in Docker and no client installed).
import { mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { compareCounts, countTables, listDump, makeTools, parseDbUrl, redact, restoreIntoScratch, run, sha256File } from "./backup-lib.mjs";

function parseArgs(argv) {
  const o = { out: process.env.BACKUP_DIR || "backups/shell", keep: Number(process.env.BACKUP_KEEP || 14), verifyRestore: false, docker: process.env.BACKUP_DOCKER || "", dockerPort: "5432", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--out") o.out = next();
    else if (a === "--keep") o.keep = Number(next());
    else if (a === "--verify-restore") o.verifyRestore = true;
    else if (a === "--docker") o.docker = next();
    else if (a === "--docker-port") o.dockerPort = next();
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(o.keep) || o.keep < 1) throw new Error("--keep must be a whole number of at least 1");
  return o;
}

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");

/** Newest first. */
export function listBackups(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^shell-\d{8}-\d{6}\.dump$/.test(f))
    .sort()
    .reverse();
}

/** Delete everything but the newest `keep` dumps (and their manifests). Returns the removed file names. */
export function prune(dir, keep) {
  const removed = [];
  for (const f of listBackups(dir).slice(keep)) {
    rmSync(join(dir, f), { force: true });
    rmSync(join(dir, `${f}.json`), { force: true });
    removed.push(f);
  }
  return removed;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node shell/scripts/backup-shell.mjs --out <dir> [--keep N] [--verify-restore] [--docker <container>] [--docker-port 5432]\nReads DATABASE_URL.");
    return 0;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  const db = parseDbUrl(url);
  const tools = makeTools({ docker: opts.docker || undefined, dockerPort: opts.dockerPort });
  const dir = resolve(opts.out);
  mkdirSync(dir, { recursive: true });
  const name = `shell-${stamp()}.dump`;
  const file = join(dir, name);
  const manifest = { file: name, createdAt: new Date().toISOString(), database: db.database, host: db.host, via: opts.docker ? `docker:${opts.docker}` : "local client", verified: false, restoreVerified: null };
  console.log(`Backing up ${db.database} on ${db.host} (${redact(url)}) via ${manifest.via}`);

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  let counts;
  try {
    const before = await countTables(sql);
    const d = await run(tools.dump(url, ["-Fc", "--no-owner", "--no-privileges"]), { stdoutFile: file });
    if (d.code !== 0) {
      rmSync(file, { force: true });
      console.error(`pg_dump failed (exit ${d.code}): ${d.stderr.split("\n").slice(-4).join(" | ")}`);
      if (/ENOENT/.test(d.stderr)) console.error("Hint: pg_dump is not installed on this machine. Install postgresql-client (version at least as new as the server), set PG_DUMP to its path, or use --docker <container> to run it inside the database container.");
      if (/version mismatch|server version/i.test(d.stderr)) console.error("Hint: install a pg_dump at least as new as the server, or use --docker with the database's own container.");
      return 1;
    }
    const after = await countTables(sql);
    counts = Object.fromEntries(Object.keys(after).map((t) => [t, { min: Math.min(before[t] ?? 0, after[t]), max: Math.max(before[t] ?? 0, after[t]) }]));
    manifest.rowCounts = after;
    manifest.sha256 = await sha256File(file);
    manifest.size = statSync(file).size;
    console.log(`  dump written: ${name} (${(manifest.size / 1024).toFixed(1)} KiB, ${Object.keys(after).length} tables)`);

    const listed = await listDump(tools, file);
    manifest.verified = true;
    manifest.tocEntries = listed.entries;
    console.log(`  pg_restore --list: ${listed.entries} entries, archive is readable`);

    if (opts.verifyRestore) {
      const r = await restoreIntoScratch(tools, url, file);
      const problems = compareCounts(counts, r.counts);
      manifest.restoreVerified = problems.length === 0;
      if (problems.length) {
        manifest.problems = problems;
        // keep it for inspection, but out of the rotation so a bad dump never pushes good ones out
        renameSync(file, `${file}.FAILED`);
        writeFileSync(`${file}.FAILED.json`, JSON.stringify(manifest, null, 2));
        console.error("  restore check FAILED:\n   - " + problems.join("\n   - "));
        return 1;
      }
      console.log(`  restore check: restored into a scratch database and all ${Object.keys(r.counts).length} table row counts match (scratch database dropped)`);
    } else {
      console.log("  restore check skipped (pass --verify-restore to prove the dump restores)");
    }
    writeFileSync(`${file}.json`, JSON.stringify(manifest, null, 2));
  } catch (e) {
    console.error(`Backup failed: ${e instanceof Error ? e.message : e}`);
    if (existsSync(file)) {
      manifest.error = String(e instanceof Error ? e.message : e);
      writeFileSync(`${file}.failed.json`, JSON.stringify(manifest, null, 2));
      rmSync(file, { force: true });
    }
    return 1;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
  const removed = prune(dir, opts.keep);
  if (removed.length) console.log(`  pruned ${removed.length} old backup(s), keeping the newest ${opts.keep}`);
  console.log(`OK: ${file}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
