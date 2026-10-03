#!/usr/bin/env python
"""Backup and restore verification for the Legal AI database and document storage.

  python scripts/backup.py backup --out backups [--docker legalai-db-1] [--with-storage]
  python scripts/backup.py verify backups/backup-YYYYmmdd-HHMMSS [--docker legalai-db-1]

`backup` writes db.dump (pg_dump -Fc), manifest.json (hashes, row counts, per-document hashes) and, with --with-storage,
storage.tar.gz. `verify` restores the dump into a scratch database, compares row counts, checks every document file
against the SHA-256 recorded in the database, and drops the scratch database. Exit code 0 only if everything matches.

The production API also runs this on a schedule (see docs/backup.md) and `scripts/pull_backup.py` copies the result off-site.
The database connection comes from DATABASE_URL (the app's SQLAlchemy URL is accepted)."""
import argparse
import os
import sys
from pathlib import Path

from legalai.backup import Pg, make_backup, parse_url, verify_backup


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL", ""), help="defaults to $DATABASE_URL")
    ap.add_argument("--docker", help="run Postgres tools inside this container")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backup")
    b.add_argument("--out", default="backups")
    b.add_argument("--storage", default=os.environ.get("STORAGE_DIR", "./data/storage"))
    b.add_argument("--with-storage", action="store_true", help="also tar the document files")
    v = sub.add_parser("verify")
    v.add_argument("backup")
    v.add_argument("--storage", default=os.environ.get("STORAGE_DIR", "./data/storage"))
    args = ap.parse_args()
    if not args.database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        return 2
    pg = Pg(parse_url(args.database_url), args.docker)
    if args.cmd == "backup":
        out = make_backup(pg, Path(args.out), Path(args.storage), include_storage=args.with_storage)
        print(f"backup written to {out}")
        return 0
    problems = verify_backup(pg, Path(args.backup), Path(args.storage))
    if problems:
        print("FAILED:", *problems, sep="\n  ")
        return 1
    print("OK: backup restores cleanly and every document file matches its recorded SHA-256")
    return 0


if __name__ == "__main__":
    sys.exit(main())
