// Shared helpers for backup-shell.mjs and restore-check.mjs. Plain Node, no dependencies except the `postgres` driver the shell already has.
// The same ideas as LegalAI's modules/legal/api/legalai/backup.py: an unverified backup is not a backup, so every dump is listed,
// and optionally restored into a scratch database whose row counts are compared with the source.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import postgres from "postgres";

export function parseDbUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error("DATABASE_URL must start with postgresql://");
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: u.port || "5432",
    database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    search: u.search,
  };
}

/** The same server, a different database. */
export function withDatabase(raw, database) {
  const u = new URL(raw);
  u.pathname = `/${encodeURIComponent(database)}`;
  return u.toString();
}

/** Never print a password. */
export function redact(raw) {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable url)";
  }
}

/**
 * Where the PostgreSQL client tools run: on this machine (`pg_dump` / `pg_restore` on PATH, or PG_DUMP / PG_RESTORE),
 * or inside a running container (`--docker <name>`, for a laptop with Postgres in Docker and no client installed).
 */
export function makeTools({ docker, pgDump = process.env.PG_DUMP || "pg_dump", pgRestore = process.env.PG_RESTORE || "pg_restore", dockerPort = "5432" }) {
  /** argv for a tool, for the database described by `url`. */
  const connect = (url) => {
    if (!docker) return { args: ["--dbname", url], env: {}, prefix: [] };
    const d = parseDbUrl(url);
    // Inside the container the server is on localhost:5432 whatever port the host maps it to.
    return {
      args: ["-h", "localhost", "-p", dockerPort, "-U", d.user, "-d", d.database],
      env: d.password ? { PGPASSWORD: d.password } : {},
      prefix: ["exec", "-i", ...(d.password ? ["-e", `PGPASSWORD=${d.password}`] : []), docker],
    };
  };
  const command = (tool, url, extra) => {
    const c = connect(url);
    if (docker) return { cmd: "docker", args: [...c.prefix, tool, ...extra, ...c.args], env: process.env };
    return { cmd: tool === "pg_dump" ? pgDump : pgRestore, args: [...extra, ...c.args], env: { ...process.env, ...c.env } };
  };
  const bare = (tool, extra) => (docker ? { cmd: "docker", args: ["exec", "-i", docker, tool, ...extra], env: process.env } : { cmd: tool === "pg_dump" ? pgDump : pgRestore, args: extra, env: process.env });
  return { dump: (url, extra = []) => command("pg_dump", url, extra), restore: (url, extra = []) => command("pg_restore", url, extra), bare, docker };
}

/** Run a command, optionally feeding a file to stdin and/or writing stdout to a file. Resolves with { code, stderr, stdout? }. */
export async function run({ cmd, args, env }, { stdinFile, stdoutFile, collectStdout = false } = {}) {
  const child = spawn(cmd, args, { env, stdio: [stdinFile ? "pipe" : "ignore", stdoutFile || collectStdout ? "pipe" : "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let stdout = "";
  const done = [once(child, "close")];
  child.on("error", () => {}); // reported through the close event or `spawn` rejection below
  if (stdoutFile) {
    const out = createWriteStream(stdoutFile);
    child.stdout.pipe(out);
    done.push(once(out, "finish"));
  } else if (collectStdout) {
    child.stdout.on("data", (d) => (stdout += d));
  }
  if (stdinFile) {
    const inp = createReadStream(stdinFile);
    inp.on("error", () => child.stdin.destroy());
    child.stdin.on("error", () => {}); // the tool may exit early (e.g. --list) and close the pipe
    inp.pipe(child.stdin);
  }
  try {
    const [[code]] = await Promise.all(done);
    return { code, stderr: stderr.trim(), stdout };
  } catch (e) {
    return { code: -1, stderr: `${cmd}: ${e.message}`, stdout };
  }
}

export async function sha256File(path) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

/** `pg_restore --list`: proves the archive is readable end to end. Returns the number of table-of-contents entries. */
export async function listDump(tools, file) {
  const r = await run(tools.bare("pg_restore", ["--list"]), { stdinFile: file, collectStdout: true });
  if (r.code !== 0) throw new Error(`pg_restore --list failed (exit ${r.code}): ${r.stderr.split("\n").slice(-3).join(" | ")}`);
  const entries = r.stdout.split("\n").filter((l) => l.trim() && !l.startsWith(";")).length;
  if (entries === 0) throw new Error("pg_restore --list returned no entries: the dump is empty");
  return { entries, toc: r.stdout };
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** Exact row count of every ordinary table in the public schema. */
export async function countTables(sql) {
  const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const out = {};
  for (const { table_name } of tables) {
    const [{ n }] = await sql.unsafe(`SELECT count(*)::bigint AS n FROM "${table_name.replaceAll('"', '""')}"`);
    out[table_name] = Number(n);
  }
  return out;
}

/**
 * Restore `file` into a brand-new scratch database on the same server, return its row counts, and drop it again (always).
 * `adminUrl` is any URL for that server; the scratch name is random and validated.
 */
export async function restoreIntoScratch(tools, adminUrl, file) {
  const name = `founderos_restore_check_${randomBytes(4).toString("hex")}`;
  if (!IDENT.test(name)) throw new Error("bad scratch name");
  const admin = postgres(withDatabase(adminUrl, parseDbUrl(adminUrl).database), { max: 1, onnotice: () => {} });
  const scratchUrl = withDatabase(adminUrl, name);
  let scratch;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const r = await run(tools.restore(scratchUrl, ["--no-owner", "--no-privileges", "--exit-on-error"]), { stdinFile: file });
    if (r.code !== 0) throw new Error(`pg_restore into scratch database failed (exit ${r.code}): ${r.stderr.split("\n").slice(-4).join(" | ")}`);
    scratch = postgres(scratchUrl, { max: 1, onnotice: () => {} });
    return { counts: await countTables(scratch), scratch: name };
  } finally {
    if (scratch) await scratch.end({ timeout: 5 }).catch(() => {});
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    await admin.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Compare restored counts with what was expected. `expected` is either { table: n } or { table: { min, max } } (a live database can change while it is dumped).
 * Returns a list of human-readable problems (empty when everything matches).
 */
export function compareCounts(expected, actual) {
  const problems = [];
  for (const [t, e] of Object.entries(expected)) {
    const min = typeof e === "number" ? e : e.min;
    const max = typeof e === "number" ? e : e.max;
    if (!(t in actual)) problems.push(`table ${t} is missing from the restore`);
    else if (actual[t] < min || actual[t] > max) problems.push(`table ${t}: restored ${actual[t]} rows, expected ${min === max ? min : `${min}-${max}`}`);
  }
  for (const t of Object.keys(actual)) if (!(t in expected)) problems.push(`table ${t} exists in the restore but not in the source`);
  return problems;
}
