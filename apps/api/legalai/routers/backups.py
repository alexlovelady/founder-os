import hmac
import json
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..backup import Pg, latest_backup, parse_url, storage_manifest
from ..config import get_settings
from ..db import get_db
from ..jobs.queue import enqueue
from ..models import DocumentVersion, User
from ..security import current_auth, current_user
from ..storage import get_storage

router = APIRouter(prefix="/api/admin/backup", tags=["backup"])


def backup_access(request: Request, x_backup_token: str | None = Header(None), db: DbSession = Depends(get_db)) -> str:
    """Admin session, or the dedicated read-only backup token (for the off-site puller). Returns who."""
    tok = get_settings().backup_token
    if tok and x_backup_token and hmac.compare_digest(x_backup_token, tok):
        return "backup-token"
    auth = current_auth(request, db)  # raises 401 / CSRF
    if auth.user.role != "admin":
        raise HTTPException(403, "Admin only")
    return f"admin:{auth.user.id}"


def _manifest(d: Path) -> dict:
    m = json.loads((d / "manifest.json").read_text())
    m.pop("storage_files", None)  # large; served by /manifest
    return {"name": d.name, **m}


@router.get("")
def list_backups(who: str = Depends(backup_access)):
    root = Path(get_settings().backup_root())
    items = [_manifest(d) for d in sorted(root.glob("backup-*"), reverse=True) if (d / "manifest.json").exists()] if root.exists() else []
    return {"enabled": get_settings().backup_enabled, "backups": items}


@router.post("", status_code=202)
def run_now(request: Request, db: DbSession = Depends(get_db), who: str = Depends(backup_access)):
    if not who.startswith("admin:"):
        raise HTTPException(403, "Admin session required")
    job = enqueue(db, "backup", matter_id=None, user_id=None, payload={}, max_attempts=2)
    audit(db, "backup.requested", object_type="backup", detail_who=who)
    db.commit()
    return {"job_id": str(job.id)}


@router.get("/manifest")
def manifest(who: str = Depends(backup_access), db: DbSession = Depends(get_db)):
    """Latest backup metadata plus the live list of document files (key, sha256, size) for incremental off-site sync."""
    last = latest_backup(Path(get_settings().backup_root()))
    files = [{"key": k, "sha256": s, "size": n} for k, s, n in db.execute(
        select(DocumentVersion.storage_key, DocumentVersion.sha256, DocumentVersion.size_bytes))]
    return {"latest": _manifest(last) if last else None, "files": files}


@router.get("/db")
def download_db(who: str = Depends(backup_access), db: DbSession = Depends(get_db)):
    last = latest_backup(Path(get_settings().backup_root()))
    if not last:
        raise HTTPException(404, "No backup exists yet")
    audit(db, "backup.downloaded", object_type="backup", object_id=last.name, detail_who=who)
    db.commit()
    return FileResponse(last / "db.dump", media_type="application/octet-stream", filename=f"{last.name}.dump")


@router.get("/file")
def download_file(key: str, who: str = Depends(backup_access), db: DbSession = Depends(get_db)):
    """One stored document file by storage key (must be a known document version, so this cannot read arbitrary paths)."""
    v = db.scalar(select(DocumentVersion).where(DocumentVersion.storage_key == key))
    if not v:
        raise HTTPException(404, "Unknown file")
    store = get_storage()
    p = store._path(v.storage_key)  # validated against traversal inside _path
    if not p.exists():
        raise HTTPException(404, "File missing from storage")
    return FileResponse(p, media_type="application/octet-stream")
