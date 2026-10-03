"""Scheduled in-app backup: dump, verify by restoring into a scratch database, record the verdict, apply retention."""
import json
import logging
from pathlib import Path

from sqlalchemy import func, select

from .audit import audit
from .backup import Pg, apply_retention, is_due, make_backup, parse_url, verify_backup
from .config import Settings
from .db import session_scope
from .jobs.queue import enqueue
from .models import Job

log = logging.getLogger("legalai.backup")


def run_backup(settings: Settings, pg: Pg | None = None) -> dict:
    pg = pg or Pg(parse_url(settings.database_url))
    root = Path(settings.backup_root())
    root.mkdir(parents=True, exist_ok=True)
    out = make_backup(pg, root, Path(settings.storage_dir), include_storage=settings.backup_include_storage)
    problems: list[str] = []
    if settings.backup_verify:
        problems = verify_backup(pg, out, Path(settings.storage_dir))
    man = json.loads((out / "manifest.json").read_text())
    from datetime import datetime, timezone
    man["verified_at"] = datetime.now(timezone.utc).isoformat() if settings.backup_verify else None
    man["verify_problems"] = problems
    (out / "manifest.json").write_text(json.dumps(man, indent=2))
    removed = apply_retention(root)
    with session_scope() as db:
        audit(db, "backup.completed", object_type="backup", object_id=out.name, verified=settings.backup_verify,
              problems=len(problems), removed_old=len(removed))
    if problems:
        raise RuntimeError("Backup verification failed: " + "; ".join(problems[:3]))
    return {"backup": out.name, "verified": settings.backup_verify, "removed_old": removed}


def enqueue_due_backups(settings: Settings) -> int:
    if not settings.backup_enabled:
        return 0
    root = Path(settings.backup_root())
    if root.exists() and not is_due(root, settings.backup_interval_hours):
        return 0
    with session_scope() as db:
        pending = db.scalar(select(func.count()).select_from(Job).where(
            Job.job_type == "backup", Job.state.in_(["QUEUED", "RUNNING", "RETRYABLE", "WAITING_FOR_GPU"])))
        if pending:
            return 0
        enqueue(db, "backup", matter_id=None, user_id=None, payload={}, max_attempts=2)
    return 1
