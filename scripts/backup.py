#!/usr/bin/env python
"""Backup and restore verification for the Legal AI database and document storage.

  python scripts/backup.py backup --out backups [--docker legalai-db-1]
  python scripts/backup.py verify backups/backup-YYYYmmdd-HHMMSS [--docker legalai-db-1]

`backup` writes db.dump (pg_dump -Fc), storage.tar.gz, and manifest.json (hashes + row counts).
`verify` restores db.dump into a scratch database, compares row counts with the manifest, extracts the storage
archive and checks every stored document file against the SHA-256 recorded in the database, then drops the scratch DB.
Exit code 0 only if everything matches. Run `verify` after every backup and at least monthly on an old one: an
unverified backup is not a backup.

Database connection comes from DATABASE_URL (the app's SQLAlchemy URL is accepted). With --docker NAME the Postgres
tools run inside that container; otherwise pg_dump/pg_restore/psql must be on PATH."""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

TABLES = ["users", "matters", "documents", "document_versions", "document_chunks", "chunk_embeddings", "research_runs",
          "contract_reviews", "obligations", "drafts", "redlines", "comparisons", "corpus_sources", "audit_events", "jobs"]


def parse_url(url: str) -> dict:
    u = urlparse(url.replace("postgresql+psycopg://", "postgresql://"))
    return {"user": unquote(u.username or ""), "password": unquote(u.password or ""), "host": u.hostname or "localhost",
            "port": str(u.port or 5432), "db": (u.path or "/").lstrip("/")}


class Pg:
    def __init__(self, cfg: dict, docker: str | None):
        self.cfg, self.docker = cfg, docker

    def _cmd(self, tool: str, *args: str, db: str | None = None, interactive: bool = False) -> list[str]:
        base = [tool, "-U", self.cfg["user"]]
        if tool in ("psql", "pg_dump", "pg_restore"):
            base += ["-h", self.cfg["host"], "-p", self.cfg["port"]] if not self.docker else []
        if db and tool == "pg_dump":
            base += [db]
        if self.docker:
            return ["docker", "exec", *(["-i"] if interactive else []), "-e", f"PGPASSWORD={self.cfg['password']}", self.docker, *base, *args]
        return [*base, *args]

    def env(self):
        return {**os.environ, "PGPASSWORD": self.cfg["password"]}

    def psql(self, sql: str, db: str | None = None) -> str:
        cmd = self._cmd("psql", "-d", db or self.cfg["db"], "-tAc", sql)
        return subprocess.run(cmd, capture_output=True, text=True, check=True, env=self.env()).stdout.strip()

    def dump(self, out_file: Path) -> None:
        cmd = self._cmd("pg_dump", "-Fc", "--no-owner", db=self.cfg["db"])
        with open(out_file, "wb") as f:
            subprocess.run(cmd, stdout=f, check=True, env=self.env())

    def restore(self, dump: Path, db: str) -> None:
        cmd = self._cmd("pg_restore", "-d", db, "--no-owner", interactive=True)
        with open(dump, "rb") as f:
            r = subprocess.run(cmd, stdin=f, capture_output=True, env=self.env())
        if r.returncode not in (0, 1):  # 1 = warnings (e.g. pre-existing extension), data still restored
            raise RuntimeError(r.stderr.decode()[:500])


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def do_backup(args) -> int:
    cfg = parse_url(args.database_url)
    pg = Pg(cfg, args.docker)
    out = Path(args.out) / f"backup-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(parents=True)
    counts = {t: int(pg.psql(f"select count(*) from {t}")) for t in TABLES}
    pg.dump(out / "db.dump")
    storage = Path(args.storage)
    with tarfile.open(out / "storage.tar.gz", "w:gz") as tar:
        if storage.exists():
            tar.add(storage, arcname="storage")
    manifest = {"created_at": datetime.now(timezone.utc).isoformat(), "database": cfg["db"], "row_counts": counts,
                "db_dump_sha256": sha256_file(out / "db.dump"), "storage_sha256": sha256_file(out / "storage.tar.gz"),
                "storage_files": sum(1 for p in storage.rglob("*") if p.is_file()) if storage.exists() else 0}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"backup written to {out}")
    print(json.dumps({"row_counts": counts, "storage_files": manifest["storage_files"]}))
    return 0


def do_verify(args) -> int:
    d = Path(args.backup)
    man = json.loads((d / "manifest.json").read_text())
    problems: list[str] = []
    if sha256_file(d / "db.dump") != man["db_dump_sha256"]:
        problems.append("db.dump hash does not match manifest")
    if sha256_file(d / "storage.tar.gz") != man["storage_sha256"]:
        problems.append("storage.tar.gz hash does not match manifest")
    if problems:
        print("FAILED:", *problems, sep="\n  ")
        return 1
    cfg = parse_url(args.database_url)
    pg = Pg(cfg, args.docker)
    scratch = f"legalai_restore_test_{datetime.now(timezone.utc).strftime('%H%M%S')}"
    pg.psql(f"create database {scratch}", db="postgres")
    try:
        pg.psql("create extension if not exists vector", db=scratch)
        pg.restore(d / "db.dump", scratch)
        for t, want in man["row_counts"].items():
            got = int(pg.psql(f"select count(*) from {t}", db=scratch))
            if got != want:
                problems.append(f"{t}: restored {got} rows, backup had {want}")
        with tempfile.TemporaryDirectory() as tmp:
            with tarfile.open(d / "storage.tar.gz") as tar:
                tar.extractall(tmp, filter="data")
            rows = pg.psql("select storage_key || '|' || sha256 from document_versions where uploaded_by is not null or true", db=scratch)
            checked = 0
            for line in filter(None, rows.splitlines()):
                key, sha = line.rsplit("|", 1)
                f = Path(tmp) / "storage" / key
                if not f.exists():
                    problems.append(f"missing file for version: {key}")
                elif sha256_file(f) != sha:
                    problems.append(f"hash mismatch: {key}")
                checked += 1
        print(f"restored into {scratch}: {len(man['row_counts'])} tables compared, {checked} document files verified")
    finally:
        pg.psql(f"drop database if exists {scratch} with (force)", db="postgres")
    if problems:
        print("FAILED:", *problems, sep="\n  ")
        return 1
    print("OK: backup restores cleanly and every document file matches its recorded SHA-256")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL", ""), help="defaults to $DATABASE_URL")
    ap.add_argument("--docker", help="run Postgres tools inside this container")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backup")
    b.add_argument("--out", default="backups")
    b.add_argument("--storage", default=os.environ.get("STORAGE_DIR", "./data/storage"))
    v = sub.add_parser("verify")
    v.add_argument("backup")
    args = ap.parse_args()
    if not args.database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2
    return do_backup(args) if args.cmd == "backup" else do_verify(args)


if __name__ == "__main__":
    sys.exit(main())
