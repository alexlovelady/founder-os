#!/usr/bin/env node
// Off-site pull of the shell database backup. Run it on your own computer (daily, Task Scheduler); mirrors LegalAI's pull_backup.py.
//
// It downloads the newest VERIFIED dump from the live shell over HTTPS, checks the sha256 (the server's header and manifest must agree with
// what arrived), stores it in a local folder, proves it is readable with `pg_restore --list` when a client exists (or via docker), and keeps the newest N.
//
//   SHELL_URL          https://your-shell.up.railway.app   (BACKUP_URL also accepted)
//   BACKUP_PULL_TOKEN  same value as the BACKUP_PULL_TOKEN variable on the shell service
//   BACKUP_DIR         where to keep copies (default ~/founderos-shell-backups)
//   KEEP               dumps to keep (default 14)
//   BACKUP_DOCKER      optional container name to run pg_restore in when the PC has no PostgreSQL client
//
// Exit code 0 only if the dump downloaded and every check that could run passed. The token is never printed.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { listDump, makeTools, run, sha256File } from "./backup-lib.mjs";

const NAME_RE = /^shell-\d{8}-\d{6}\.dump$/;

/** Is a pg_restore usable here (directly, or inside BACKUP_DOCKER)? */
export async function restoreClientAvailable(tools) {
  const r = await run(tools.bare("pg_restore", ["--version"]), { collectStdout: true });
  return r.code === 0;
}

async function download(fetchFn, url, token, dest) {
  const res = await fetchFn(url, { headers: { "x-internal-token": token } });
  if (!res.ok) throw new Error(`${url.split("?")[0]} answered ${res.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const part = `${dest}.part`;
  const tap = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(res.body), tap, createWriteStream(part));
  } catch (e) {
    rmSync(part, { force: true });
    throw e;
  }
  return { part, sha256: hash.digest("hex"), bytes, headerSha: res.headers.get("x-backup-sha256"), headerName: res.headers.get("x-backup-name") };
}

export function pruneLocal(dir, keep) {
  const files = readdirSync(dir).filter((f) => NAME_RE.test(f)).sort().reverse();
  const removed = [];
  for (const f of files.slice(keep)) {
    rmSync(join(dir, f), { force: true });
    rmSync(join(dir, `${f}.json`), { force: true });
    removed.push(f);
  }
  return removed;
}

/** The whole pull. Returns { ok, file, problems, notes }. `fetchFn` and `tools` are injectable for tests. */
export async function pull({ url, token, dir, keep = 14, fetchFn = fetch, tools = makeTools({ docker: process.env.BACKUP_DOCKER || undefined }), verifyList = true }) {
  const problems = [];
  const notes = [];
  const base = url.replace(/\/+$/, "");
  mkdirSync(dir, { recursive: true });

  const mres = await fetchFn(`${base}/api/internal/backups/manifest`, { headers: { "x-internal-token": token } });
  if (mres.status === 404) return { ok: false, file: null, problems: ["the server has no pull endpoint: BACKUP_PULL_TOKEN is not set on the shell service"], notes };
  if (mres.status === 401) return { ok: false, file: null, problems: ["the server rejected the token (BACKUP_PULL_TOKEN differs)"], notes };
  if (!mres.ok) return { ok: false, file: null, problems: [`manifest request answered ${mres.status}`], notes };
  const manifest = await mres.json();
  const latest = manifest.latest;
  if (!latest) return { ok: false, file: null, problems: [manifest.configured === false ? "backups are not configured on the server" : "the server has no verified backup yet"], notes };
  if (!NAME_RE.test(latest.name)) return { ok: false, file: null, problems: ["the server named the dump unexpectedly; refusing"], notes };

  const target = join(dir, latest.name);
  let have = existsSync(target) && (await sha256File(target)) === latest.sha256;
  if (have) notes.push("already downloaded and intact");
  else {
    const d = await download(fetchFn, `${base}/api/internal/backups/latest`, token, target);
    if (d.headerName && d.headerName !== latest.name) {
      // a newer backup appeared between the two requests: trust the file that actually arrived, judged by its own header
      notes.push(`server's latest changed from ${latest.name} to ${d.headerName} during the pull`);
    }
    if (!d.headerSha || d.sha256 !== d.headerSha) {
      rmSync(d.part, { force: true });
      return { ok: false, file: null, problems: ["sha256 of the downloaded file does not match the server's X-Backup-Sha256 header (corrupt or tampered download)"], notes };
    }
    const finalName = d.headerName && NAME_RE.test(d.headerName) ? d.headerName : latest.name;
    if (finalName === latest.name && d.sha256 !== latest.sha256) {
      rmSync(d.part, { force: true });
      return { ok: false, file: null, problems: ["sha256 of the downloaded file does not match the manifest"], notes };
    }
    renameSync(d.part, join(dir, finalName));
    have = true;
    latest.name = finalName;
    latest.sha256 = d.sha256;
    latest.size = d.bytes;
  }
  const file = join(dir, latest.name);
  writeFileSync(`${file}.json`, JSON.stringify({ ...latest, pulledAt: new Date().toISOString() }, null, 2));

  if (verifyList) {
    if (await restoreClientAvailable(tools)) {
      try {
        const l = await listDump(tools, file);
        notes.push(`pg_restore --list: ${l.entries} entries, archive is readable`);
      } catch (e) {
        problems.push(`downloaded dump is not a readable archive: ${e.message}`);
        renameSync(file, `${file}.BAD`);
      }
    } else {
      notes.push("NOT verified with pg_restore: no PostgreSQL client or BACKUP_DOCKER container found (the sha256 matched, which proves it arrived intact)");
    }
  }
  if (problems.length === 0) {
    const removed = pruneLocal(dir, keep);
    if (removed.length) notes.push(`pruned ${removed.length} old file(s), keeping ${keep}`);
  }
  return { ok: problems.length === 0, file: problems.length === 0 ? file : null, problems, notes };
}

async function main() {
  const url = process.env.SHELL_URL || process.env.BACKUP_URL || "";
  const token = process.env.BACKUP_PULL_TOKEN || "";
  if (!url || !token) {
    console.error("SHELL_URL and BACKUP_PULL_TOKEN are required");
    return 2;
  }
  const dir = resolve(process.env.BACKUP_DIR || join(homedir(), "founderos-shell-backups"));
  const keep = Number(process.env.KEEP || 14);
  if (!Number.isInteger(keep) || keep < 1) {
    console.error("KEEP must be a whole number of at least 1");
    return 2;
  }
  let r;
  try {
    r = await pull({ url, token, dir, keep });
  } catch (e) {
    console.error(`Pull failed: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  for (const n of r.notes) console.log(`  ${n}`);
  if (!r.ok) {
    console.error("PROBLEMS:\n  " + r.problems.join("\n  "));
    return 1;
  }
  console.log(`OK: ${r.file}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
