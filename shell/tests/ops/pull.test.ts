import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { latestResponse, manifestResponse, tokenMatches, pullTokenConfigured } from "../../src/lib/ops/pull";
import { pull, pruneLocal } from "../../scripts/pull-shell-backup.mjs";

const TOKEN = "t".repeat(40);
let env: TestEnv;
let server: Server;
let base = "";
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "shpull-")); dirs.push(d); return d; };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const CONTENT = Buffer.alloc(300_000, "dumpdata");
let vars: Record<string, string | undefined>;

async function seed(dir: string, name: string, content: Buffer, verified = true) {
  writeFileSync(join(dir, name), content);
  await env.sql`INSERT INTO shell_backups (file_name, size_bytes, sha256, tables, verified, created_at) VALUES (${name}, ${content.length}, ${sha(content)}, ${env.sql.json({ a: 1 })}, ${verified}, now())`;
}

beforeAll(async () => {
  env = await makeTestEnv([]);
  // A tiny real HTTP server in front of the route logic, so the puller script runs end to end over the network.
  server = createServer(async (req, res) => {
    const r = new Request(`http://x${req.url}`, { headers: req.headers as Record<string, string> });
    const out = req.url!.startsWith("/api/internal/backups/latest") ? await latestResponse(env.sql, r, vars) : await manifestResponse(env.sql, r, vars);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    if (out.body) Readable.fromWeb(out.body as never).pipe(res);
    else res.end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { server.close(); await env.cleanup(); });
beforeEach(async () => { await env.sql`DELETE FROM shell_backups`; });
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("token gate", () => {
  const req = (t?: string) => new Request("http://x/api/internal/backups/latest", { headers: t ? { "x-internal-token": t } : {} });
  it("404 when BACKUP_PULL_TOKEN is unset or too short, 401 for a missing or wrong token", async () => {
    expect((await latestResponse(env.sql, req(TOKEN), {})).status).toBe(404);
    expect((await latestResponse(env.sql, req("short"), { BACKUP_PULL_TOKEN: "short" })).status).toBe(404);
    expect((await manifestResponse(env.sql, req(TOKEN), {})).status).toBe(404);
    const e = { BACKUP_PULL_TOKEN: TOKEN, BACKUP_DIR: tmp() };
    expect((await latestResponse(env.sql, req(), e)).status).toBe(401);
    expect((await latestResponse(env.sql, req("x".repeat(40)), e)).status).toBe(401);
    expect((await manifestResponse(env.sql, req("x"), e)).status).toBe(401);
  });
  it("is separate from INTERNAL_PROVISION_TOKEN", () => {
    expect(tokenMatches(TOKEN, { INTERNAL_PROVISION_TOKEN: TOKEN })).toBe(false);
    expect(pullTokenConfigured({ INTERNAL_PROVISION_TOKEN: TOKEN })).toBe(false);
    expect(tokenMatches(TOKEN, { BACKUP_PULL_TOKEN: TOKEN })).toBe(true);
  });
  it("503 when the token is right but BACKUP_DIR is unset; 404 when there is no verified backup", async () => {
    expect((await latestResponse(env.sql, req(TOKEN), { BACKUP_PULL_TOKEN: TOKEN })).status).toBe(503);
    expect((await latestResponse(env.sql, req(TOKEN), { BACKUP_PULL_TOKEN: TOKEN, BACKUP_DIR: tmp() })).status).toBe(404);
  });
});

describe("streaming the latest verified dump", () => {
  it("streams the newest verified file with its sha256 in a header, skipping unverified ones", async () => {
    const dir = tmp();
    await seed(dir, "shell-20261001-010000.dump", Buffer.from("older"));
    await seed(dir, "shell-20261002-010000.dump", CONTENT);
    await seed(dir, "shell-20261003-010000.dump", Buffer.from("unverified"), false);
    const e = { BACKUP_PULL_TOKEN: TOKEN, BACKUP_DIR: dir };
    const res = await latestResponse(env.sql, new Request("http://x/", { headers: { "x-internal-token": TOKEN } }), e);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-backup-sha256")).toBe(sha(CONTENT));
    expect(res.headers.get("x-backup-name")).toBe("shell-20261002-010000.dump");
    expect(res.headers.get("content-length")).toBe(String(CONTENT.length));
    expect(sha(Buffer.from(await res.arrayBuffer()))).toBe(sha(CONTENT));
    const m = await (await manifestResponse(env.sql, new Request("http://x/", { headers: { "x-internal-token": TOKEN } }), e)).json();
    expect(m.latest).toMatchObject({ name: "shell-20261002-010000.dump", sha256: sha(CONTENT) });
    expect(m.backups).toHaveLength(2);
  });
});

describe("pull-shell-backup.mjs against a fake server", () => {
  const noList = { verifyList: false };
  it("downloads, verifies the hash, stores, prunes, and is a no-op the second time", async () => {
    const srv = tmp(), local = tmp();
    vars = { BACKUP_PULL_TOKEN: TOKEN, BACKUP_DIR: srv };
    await seed(srv, "shell-20261001-010000.dump", Buffer.from("old one"));
    await seed(srv, "shell-20261002-010000.dump", CONTENT);
    writeFileSync(join(local, "shell-20260901-010000.dump"), "ancient");
    const r = await pull({ url: base, token: TOKEN, dir: local, keep: 1, ...noList });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(sha(readFileSync(join(local, "shell-20261002-010000.dump")))).toBe(sha(CONTENT));
    expect(readdirSync(local).sort()).toEqual(["shell-20261002-010000.dump", "shell-20261002-010000.dump.json"]);
    const again = await pull({ url: base, token: TOKEN, dir: local, keep: 1, ...noList });
    expect(again.ok).toBe(true);
    expect(again.notes.join(" ")).toMatch(/already downloaded/);
  });

  it("rejects a download whose bytes do not match the server's sha256", async () => {
    const srv = tmp(), local = tmp();
    vars = { BACKUP_PULL_TOKEN: TOKEN, BACKUP_DIR: srv };
    await seed(srv, "shell-20261002-010000.dump", CONTENT);
    writeFileSync(join(srv, "shell-20261002-010000.dump"), Buffer.alloc(CONTENT.length, "tampered")); // changed after it was verified
    const r = await pull({ url: base, token: TOKEN, dir: local, ...noList });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/sha256/);
    expect(readdirSync(local)).toEqual([]);
  });

  it("reports a wrong token, a server without the token, and no backup", async () => {
    const srv = tmp(), local = tmp();
    vars = { BACKUP_PULL_TOKEN: TOKEN, BACKUP_DIR: srv };
    expect((await pull({ url: base, token: "w".repeat(40), dir: local, ...noList })).problems[0]).toMatch(/rejected the token/);
    expect((await pull({ url: base, token: TOKEN, dir: local, ...noList })).problems[0]).toMatch(/no verified backup/);
    vars = {};
    expect((await pull({ url: base, token: TOKEN, dir: local, ...noList })).problems[0]).toMatch(/not set on the shell service/);
  });

  it("without a pg_restore client it says the dump was not list-verified but still succeeds on a matching hash", async () => {
    const srv = tmp(), local = tmp();
    vars = { BACKUP_PULL_TOKEN: TOKEN, BACKUP_DIR: srv };
    await seed(srv, "shell-20261002-010000.dump", CONTENT);
    const none = { bare: () => ({ cmd: "definitely-not-a-real-binary-xyz", args: [], env: process.env }) } as never;
    const r = await pull({ url: base, token: TOKEN, dir: local, tools: none });
    expect(r.ok).toBe(true);
    expect(r.notes.join(" ")).toMatch(/NOT verified with pg_restore/);
  });

  it("pruneLocal keeps the newest N", () => {
    const d = tmp();
    for (const n of ["shell-20261001-010000.dump", "shell-20261002-010000.dump", "other.txt"]) writeFileSync(join(d, n), "x");
    expect(pruneLocal(d, 1)).toEqual(["shell-20261001-010000.dump"]);
  });
});
