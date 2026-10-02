import os
import time
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..models import (Document, DocumentChunk, DocumentVersion, GpuNode, Job, Matter, ProviderUsage, ResearchRun, Session, User)
from ..privacy import embedding_spend, external_llm_spend
from ..security import current_user, require_admin
from .. import worker

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/health")
def health(admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    s = get_settings()
    checks: dict[str, dict] = {}
    try:
        db.execute(text("select 1"))
        checks["database"] = {"ok": True}
    except Exception as e:  # noqa: BLE001
        db.rollback()
        checks["database"] = {"ok": False, "error": type(e).__name__}
    try:
        checks["database"]["revision"] = db.scalar(text("select version_num from alembic_version"))
    except Exception:  # noqa: BLE001 - e.g. schema created without migrations (tests)
        db.rollback()
    try:
        p = os.path.join(s.storage_dir, ".healthcheck")
        os.makedirs(s.storage_dir, exist_ok=True)
        with open(p, "w") as f:
            f.write(str(time.time()))
        os.remove(p)
        checks["storage"] = {"ok": True}
    except OSError as e:
        checks["storage"] = {"ok": False, "error": type(e).__name__}
    age = time.monotonic() - worker.LAST_TICK if worker.LAST_TICK else None
    checks["worker"] = {"ok": (not s.run_worker) or (age is not None and age < 30), "seconds_since_tick": round(age, 1) if age else None,
                        "embedded": s.run_worker}
    n = db.get(GpuNode, s.gpu_node_id)
    fresh = bool(n and n.last_heartbeat_at and (datetime.now(timezone.utc) - n.last_heartbeat_at).total_seconds() < s.gpu_heartbeat_stale_s)
    checks["gpu"] = {"ok": fresh, "optional": True, "status": n.status if n else "never seen"}
    oldest = db.scalar(select(func.min(Job.created_at)).where(Job.state.in_(["QUEUED", "WAITING_FOR_GPU", "RETRYABLE"])))
    checks["queue"] = {"ok": True, "oldest_waiting_minutes": round((datetime.now(timezone.utc) - oldest).total_seconds() / 60, 1) if oldest else 0}
    required_ok = all(c["ok"] for k, c in checks.items() if not c.get("optional"))
    return {"ok": required_ok, "checks": checks}


@router.get("/metrics")
def metrics(admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    s = get_settings()
    count = lambda m, *w: db.scalar(select(func.count()).select_from(m).where(*w)) or 0
    since = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    usage = db.execute(select(ProviderUsage.provider, ProviderUsage.kind, ProviderUsage.external, func.count(),
                              func.coalesce(func.sum(ProviderUsage.prompt_tokens + ProviderUsage.completion_tokens), 0),
                              func.coalesce(func.sum(ProviderUsage.cost_usd), 0.0))
                       .where(ProviderUsage.created_at >= since).group_by(ProviderUsage.provider, ProviderUsage.kind, ProviderUsage.external)).all()
    return {
        "counts": {"users": count(User), "matters": count(Matter, Matter.kind == "matter", Matter.deleted_at.is_(None)),
                   "documents": count(Document, Document.deleted_at.is_(None)), "chunks": count(DocumentChunk),
                   "research_runs": count(ResearchRun), "active_sessions": count(Session, Session.expires_at > datetime.now(timezone.utc))},
        "jobs": dict(db.execute(select(Job.state, func.count()).group_by(Job.state)).all()),
        "storage_bytes": int(db.scalar(select(func.coalesce(func.sum(DocumentVersion.size_bytes), 0))) or 0),
        "database_bytes": int(db.scalar(text("select pg_database_size(current_database())")) or 0),
        "usage_month_to_date": [{"provider": p, "kind": k, "external": e, "calls": c, "tokens": int(t), "cost_usd": round(float(cost), 4)}
                                for p, k, e, c, t, cost in usage],
        "budgets": {"external_llm": {"limit_usd": s.external_llm_monthly_budget_usd, "spent_usd": round(external_llm_spend(db), 4)},
                    "embedding": {"limit_usd": s.embedding_monthly_budget_usd, "spent_usd": round(embedding_spend(db), 4)}},
    }


@router.get("/users")
def list_users(admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    return [{"id": str(u.id), "email": u.email, "display_name": u.display_name, "role": u.role, "is_active": u.is_active,
             "created_at": u.created_at.isoformat()} for u in db.scalars(select(User).order_by(User.created_at))]


class UserPatch(BaseModel):
    is_active: bool


@router.patch("/users/{uid}")
def patch_user(uid: uuid.UUID, body: UserPatch, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    u = db.get(User, uid)
    if not u:
        raise HTTPException(404, "User not found")
    if u.id == admin.id and not body.is_active:
        raise HTTPException(409, "You cannot deactivate your own account")
    u.is_active = body.is_active
    if not body.is_active:  # end their sessions immediately
        for s in db.scalars(select(Session).where(Session.user_id == u.id)):
            db.delete(s)
    audit(db, "user.active_changed", user_id=admin.id, object_type="user", object_id=u.id, is_active=body.is_active)
    db.commit()
    return {"id": str(u.id), "is_active": u.is_active}
