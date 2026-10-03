"""Database + document backups with restore verification. Used by the scheduled job in the API process, by
scripts/backup.py on a workstation, and by the off-site puller.

A backup directory contains db.dump (pg_dump -Fc), manifest.json (hashes, row counts, per-file document hashes) and,
optionally, storage.tar.gz. `verify_backup` restores the dump into a scratch database, compares row counts and
checks every stored document file against the SHA-256 recorded in the database."""
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import unquote, urlparse

TABLES = ["users", "matters", "documents", "document_versions", "document_chunks", "chunk_embeddings", "research_runs",
          "contract_reviews", "obligations", "drafts", "redlines", "comparisons", "corpus_sources", "audit_events", "jobs"]


def parse_url(url: str) -> dict:
    u = urlparse(url.replace("postgresql+psycopg://", "postgresql://"))
    return {"user": unquote(u.username or ""), "password": unquote(u.password or ""), "host": u.hostname or "localhost",
            "port": str(u.port or 5432), "db": (u.path or "/").lstrip("/")}


class Pg:
    """Runs Postgres client tools directly, or inside a Docker container with `docker`."""

    def __init__(self, cfg: dict, docker: str | None = None):
        self.cfg, self.docker = cfg, docker

    def _cmd(self, tool: str, *args: str, interactive: bool = False) -> list[str]:
        base = [tool, "-U", self.cfg["user"]]
        if not self.docker:
            base += ["-h", self.cfg["host"], "-p", self.cfg["port"]]
            return [*base, *args]
        return ["docker", "exec", *(["-i"] if interactive else []), "-e", f"PGPASSWORD={self.cfg['password']}", self.docker, *base, *args]

    def env(self):
        return {**os.environ, "PGPASSWORD": self.cfg["password"]}

    def psql(self, sql: str, db: str | None = None) -> str:
        cmd = self._cmd("psql", "-d", db or self.cfg["db"], "-tAc", sql)
        return subprocess.run(cmd, capture_output=True, text=True, check=True, env=self.env()).stdout.strip()

    def dump(self, out_file: Path) -> None:
        with open(out_file, "wb") as f:
            subprocess.run(self._cmd("pg_dump", "-Fc", "--no-owner", self.cfg["db"]), stdout=f, check=True, env=self.env())

    def restore(self, dump: Path, db: str) -> None:
        with open(dump, "rb") as f:
            r = subprocess.run(self._cmd("pg_restore", "-d", db, "--no-owner", interactive=True), stdin=f, capture_output=True, env=self.env())
        if r.returncode not in (0, 1):  # 1 = warnings only (e.g. extension already exists); data is restored
            raise RuntimeError(r.stderr.decode()[:500])


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def storage_manifest(pg: Pg) -> list[dict]:
    rows = pg.psql("select storage_key || '|' || sha256 || '|' || size_bytes from document_versions")
    out = []
    for line in filter(None, rows.splitlines()):
        key, sha, size = line.rsplit("|", 2)
        out.append({"key": key, "sha256": sha, "size": int(size)})
    return out


def make_backup(pg: Pg, out_root: Path, storage_dir: Path | None, include_storage: bool = False) -> Path:
    out = out_root / f"backup-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(parents=True)
    counts = {t: int(pg.psql(f"select count(*) from {t}")) for t in TABLES}
    files = storage_manifest(pg)
    pg.dump(out / "db.dump")
    manifest = {"created_at": datetime.now(timezone.utc).isoformat(), "database": pg.cfg["db"], "row_counts": counts,
                "db_dump_sha256": sha256_file(out / "db.dump"), "db_dump_bytes": (out / "db.dump").stat().st_size,
                "storage_files": files, "storage_archive": None}
    if include_storage and storage_dir and storage_dir.exists():
        with tarfile.open(out / "storage.tar.gz", "w:gz") as tar:
            tar.add(storage_dir, arcname="storage")
        manifest["storage_archive"] = {"sha256": sha256_file(out / "storage.tar.gz")}
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return out


def verify_backup(pg: Pg, backup_dir: Path, storage_dir: Path | None = None) -> list[str]:
    """Returns a list of problems (empty = the backup restores cleanly and documents match their recorded hashes).
    Document files are checked from the archive if the backup has one, otherwise from `storage_dir` (the live volume)."""
    man = json.loads((backup_dir / "manifest.json").read_text())
    problems: list[str] = []
    if sha256_file(backup_dir / "db.dump") != man["db_dump_sha256"]:
        return ["db.dump hash does not match manifest"]
    scratch = f"legalai_restore_test_{datetime.now(timezone.utc).strftime('%H%M%S%f')}"
    pg.psql(f"create database {scratch}", db="postgres")
    try:
        pg.psql("create extension if not exists vector", db=scratch)
        pg.restore(backup_dir / "db.dump", scratch)
        for t, want in man["row_counts"].items():
            got = int(pg.psql(f"select count(*) from {t}", db=scratch))
            if got != want:
                problems.append(f"{t}: restored {got} rows, backup had {want}")
        rows = pg.psql("select storage_key || '|' || sha256 from document_versions", db=scratch)
        with tempfile.TemporaryDirectory() as tmp:
            root = storage_dir
            if man.get("storage_archive"):
                if sha256_file(backup_dir / "storage.tar.gz") != man["storage_archive"]["sha256"]:
                    problems.append("storage.tar.gz hash does not match manifest")
                with tarfile.open(backup_dir / "storage.tar.gz") as tar:
                    tar.extractall(tmp, filter="data")
                root = Path(tmp) / "storage"
            if root is not None:
                for line in filter(None, rows.splitlines()):
                    key, sha = line.rsplit("|", 1)
                    f = root / key
                    if not f.exists():
                        problems.append(f"missing file: {key}")
                    elif sha256_file(f) != sha:
                        problems.append(f"hash mismatch: {key}")
    finally:
        pg.psql(f"drop database if exists {scratch} with (force)", db="postgres")
    return problems


def apply_retention(root: Path, keep_daily: int = 7, keep_weekly: int = 4) -> list[str]:
    """Keep the newest `keep_daily` backups plus the newest one from each of the last `keep_weekly` ISO weeks."""
    dirs = sorted((d for d in root.glob("backup-*") if d.is_dir()), reverse=True)
    keep = set(dirs[:keep_daily])
    weeks: dict[tuple, Path] = {}
    for d in dirs:
        try:
            t = datetime.strptime(d.name[7:22], "%Y%m%d-%H%M%S")
        except ValueError:
            continue
        weeks.setdefault(t.isocalendar()[:2], d)
    keep |= set(sorted(weeks.values(), reverse=True)[:keep_weekly])
    removed = []
    for d in dirs:
        if d not in keep:
            shutil.rmtree(d, ignore_errors=True)
            removed.append(d.name)
    return removed


def latest_backup(root: Path) -> Path | None:
    dirs = sorted((d for d in root.glob("backup-*") if (d / "manifest.json").exists()), reverse=True)
    return dirs[0] if dirs else None


def is_due(root: Path, interval_hours: int) -> bool:
    last = latest_backup(root)
    if not last:
        return True
    created = datetime.fromisoformat(json.loads((last / "manifest.json").read_text())["created_at"])
    return datetime.now(timezone.utc) - created >= timedelta(hours=interval_hours)
