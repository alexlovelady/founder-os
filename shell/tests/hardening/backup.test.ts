import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareCounts, parseDbUrl, redact, withDatabase } from "../../scripts/backup-lib.mjs";
import { listBackups, prune } from "../../scripts/backup-shell.mjs";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function fixture(names: string[]) {
  const d = mkdtempSync(join(tmpdir(), "bk-"));
  dirs.push(d);
  for (const n of names) {
    writeFileSync(join(d, n), "x");
    if (n.endsWith(".dump")) writeFileSync(join(d, `${n}.json`), "{}");
  }
  return d;
}

describe("prune / listBackups", () => {
  const names = ["shell-20261001-010000.dump", "shell-20261002-010000.dump", "shell-20261003-010000.dump", "shell-20261004-010000.dump"];
  it("lists newest first and ignores unrelated files", () => {
    const d = fixture([...names, "notes.txt", "shell-20261005-010000.dump.FAILED"]);
    expect(listBackups(d)).toEqual([...names].reverse());
  });
  it("keeps the newest N and removes manifests with their dumps", () => {
    const d = fixture([...names, "notes.txt"]);
    expect(prune(d, 2)).toEqual([names[1], names[0]]);
    expect(readdirSync(d).sort()).toEqual(["notes.txt", `${names[2]}`, `${names[2]}.json`, names[3], `${names[3]}.json`].sort());
  });
  it("never deletes anything when there are fewer than N", () => {
    const d = fixture(names.slice(0, 2));
    expect(prune(d, 5)).toEqual([]);
    expect(listBackups(d)).toHaveLength(2);
  });
  it("a missing directory is just empty", () => expect(listBackups(join(tmpdir(), "does-not-exist-bk"))).toEqual([]));
});

describe("compareCounts", () => {
  it("accepts exact matches and ranges", () => {
    expect(compareCounts({ a: 3, b: { min: 5, max: 7 } }, { a: 3, b: 6 })).toEqual([]);
  });
  it("reports wrong counts, missing and extra tables", () => {
    const p = compareCounts({ a: 3, b: { min: 5, max: 7 }, c: 1 }, { a: 2, b: 9, d: 0 });
    expect(p).toHaveLength(4);
    expect(p.join("|")).toMatch(/table a: restored 2 rows, expected 3/);
    expect(p.join("|")).toMatch(/table b: restored 9 rows, expected 5-7/);
    expect(p.join("|")).toMatch(/table c is missing/);
    expect(p.join("|")).toMatch(/table d exists in the restore/);
  });
});

describe("url helpers", () => {
  it("parses, swaps the database and never prints the password", () => {
    const u = "postgresql://legalai:p%40ss@localhost:5442/founderos?sslmode=disable";
    expect(parseDbUrl(u)).toMatchObject({ user: "legalai", password: "p@ss", host: "localhost", port: "5442", database: "founderos" });
    expect(withDatabase(u, "scratch")).toContain("/scratch");
    expect(redact(u)).not.toContain("p%40ss");
    expect(redact(u)).toContain("***");
  });
  it("rejects non-postgres urls", () => {
    expect(() => parseDbUrl("mysql://a@b/c")).toThrow();
    expect(() => parseDbUrl("nope")).toThrow();
  });
});
