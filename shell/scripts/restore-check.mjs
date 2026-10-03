#!/usr/bin/env node
// Prove that a stored shell backup restores. Run it on a schedule or after any change to the backup setup.
//
//   node shell/scripts/restore-check.mjs [<dump file or backup directory>] [--docker <container>] [--max-age-hours 36]
//
// Uses the newest shell-*.dump in the directory when given a directory (default BACKUP_DIR or backups/shell).
// Checks: the file's SHA-256 matches its manifest, `pg_restore --list` reads it, a restore into a scratch database on the server
// named by DATABASE_URL succeeds (the scratch database is dropped afterwards) and every table's row count equals the manifest's.
// Also fails when the newest backup is older than --max-age-hours (default 36), so a silently stopped schedule is noticed.
// Exit code 0 only when all of that holds. Never touches the real database's data.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareCounts, listDump, makeTools, parseDbUrl, redact, restoreIntoScratch, sha256File } from "./backup-lib.mjs";
import { listBackups } from "./backup-shell.mjs";

function parseArgs(argv) {
  const o = { target: process.env.BACKUP_DIR || "backups/shell", docker: process.env.BACKUP_DOCKER || "", dockerPort: "5432", maxAgeHours: 36, help: false };
  let seenTarget = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--docker") o.docker = argv[++i];
    else if (a === "--docker-port") o.dockerPort = argv[++i];
    else if (a === "--max-age-hours") o.maxAgeHours = Number(argv[++i]);
    else if (a === "--help" || a === "-h") o.help = true;
    else if (!a.startsWith("--") && !seenTarget) { o.target = a; seenTarget = true; }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node shell/scripts/restore-check.mjs [<dump file or directory>] [--docker <container>] [--max-age-hours 36]\nReads DATABASE_URL (only to find a server to create the scratch database on).");
    return 0;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    return 2;
  }
  const target = resolve(opts.target);
  if (!existsSync(target)) {
    console.error(`Not found: ${target}`);
    return 1;
  }
  let file = target;
  if (statSync(target).isDirectory()) {
    const newest = listBackups(target)[0];
    if (!newest) {
      console.error(`No shell-*.dump files in ${target}`);
      return 1;
    }
    file = join(target, newest);
  }
  const problems = [];
  const manifestPath = `${file}.json`;
  if (!existsSync(manifestPath)) {
    console.error(`Missing manifest ${manifestPath}: cannot compare row counts. Re-run backup-shell.mjs.`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  console.log(`Checking ${file} against ${parseDbUrl(url).host} (${redact(url)})`);

  const ageH = (Date.now() - statSync(file).mtimeMs) / 3_600_000;
  console.log(`  age: ${ageH.toFixed(1)} hours`);
  if (ageH > opts.maxAgeHours) problems.push(`newest backup is ${ageH.toFixed(1)} hours old (limit ${opts.maxAgeHours}): is the schedule running?`);

  const sha = await sha256File(file);
  if (sha !== manifest.sha256) problems.push("SHA-256 does not match the manifest: the file changed or is corrupt");
  else console.log("  sha256 matches the manifest");

  const tools = makeTools({ docker: opts.docker || undefined, dockerPort: opts.dockerPort });
  try {
    const l = await listDump(tools, file);
    console.log(`  pg_restore --list: ${l.entries} entries`);
    const r = await restoreIntoScratch(tools, url, file);
    const diff = compareCounts(manifest.rowCounts, r.counts);
    problems.push(...diff);
    if (!diff.length) console.log(`  restored into a scratch database: all ${Object.keys(r.counts).length} table row counts match the manifest (scratch database dropped)`);
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  if (problems.length) {
    console.error("FAILED:\n  - " + problems.join("\n  - "));
    return 1;
  }
  console.log("OK: the backup restores cleanly");
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
