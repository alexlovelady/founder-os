#!/usr/bin/env python
"""Off-site backup puller. Run from your own computer (daily, via Task Scheduler / cron).

Copies the server's latest verified database dump and mirrors every document file to local disk, checking each against
its SHA-256. Needs only an outbound HTTPS connection and the read-only BACKUP_TOKEN; it cannot change anything.

  BACKUP_URL    https://your-app.up.railway.app
  BACKUP_TOKEN  same value as the BACKUP_TOKEN variable on the server
  BACKUP_DIR    where to keep copies (default ~/legalai-backups)
  KEEP          database dumps to keep (default 14)

Exit code 0 only if everything downloaded and verified."""
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import httpx


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(client: httpx.Client, url: str, dest: Path, params: dict | None = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with client.stream("GET", url, params=params) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
    os.replace(tmp, dest)


def pull(client: httpx.Client, dest: Path, keep: int = 14) -> dict:
    m = client.get("/api/admin/backup/manifest")
    m.raise_for_status()
    data = m.json()
    latest = data["latest"]
    problems: list[str] = []
    report = {"db": None, "files_downloaded": 0, "files_ok": 0, "problems": problems}
    if not latest:
        problems.append("server has no backup yet")
        return report
    if latest.get("verify_problems"):
        problems.append("server reported verification problems for its latest backup: " + "; ".join(latest["verify_problems"][:3]))
    dumps = dest / "db"
    target = dumps / f"{latest['name']}.dump"
    if not target.exists():
        download(client, "/api/admin/backup/db", target)
    if sha256_file(target) != latest["db_dump_sha256"]:
        target.unlink(missing_ok=True)
        problems.append("database dump hash mismatch after download")
    else:
        report["db"] = target.name
    (dumps / f"{latest['name']}.manifest.json").write_text(json.dumps(latest, indent=2))
    for old in sorted(dumps.glob("backup-*.dump"), reverse=True)[keep:]:
        old.unlink()
        (dumps / old.name.replace(".dump", ".manifest.json")).unlink(missing_ok=True)
    files = dest / "files"
    for f in data["files"]:
        p = files / f["key"]
        if p.exists() and sha256_file(p) == f["sha256"]:
            report["files_ok"] += 1
            continue
        try:
            download(client, "/api/admin/backup/file", p, {"key": f["key"]})
        except httpx.HTTPError as e:
            problems.append(f"could not download {f['key']}: {type(e).__name__}")
            continue
        report["files_downloaded"] += 1
        if sha256_file(p) != f["sha256"]:
            p.unlink(missing_ok=True)
            problems.append(f"hash mismatch after download: {f['key']}")
        else:
            report["files_ok"] += 1
    return report


def main() -> int:
    url, token = os.environ.get("BACKUP_URL", ""), os.environ.get("BACKUP_TOKEN", "")
    if not url or not token:
        print("BACKUP_URL and BACKUP_TOKEN are required", file=sys.stderr)
        return 2
    dest = Path(os.environ.get("BACKUP_DIR", str(Path.home() / "legalai-backups")))
    with httpx.Client(base_url=url.rstrip("/"), headers={"X-Backup-Token": token}, timeout=httpx.Timeout(300, connect=20)) as c:
        rep = pull(c, dest, int(os.environ.get("KEEP", "14")))
    print(json.dumps({k: v for k, v in rep.items() if k != "problems"}), file=sys.stderr if rep["problems"] else sys.stdout)
    if rep["problems"]:
        print("PROBLEMS:", *rep["problems"], sep="\n  ", file=sys.stderr)
        return 1
    print(f"OK: database dump {rep['db']} and {rep['files_ok']} document files verified in {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
