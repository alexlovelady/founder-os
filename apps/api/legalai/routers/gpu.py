from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from ..config import get_settings
from ..db import get_db
from ..models import GpuNode, Job, JobState as S, User
from ..security import current_user, node_auth_ok

router = APIRouter(prefix="/api", tags=["gpu"])


class Heartbeat(BaseModel):
    node_id: str
    status: str = "online"
    gpu: str = ""
    vram_total_mb: int | None = None
    vram_free_mb: int | None = None
    models: list[str] = []
    active_jobs: int = 0


@router.post("/gpu/heartbeat")
def heartbeat(hb: Heartbeat, authorization: str | None = Header(None), db: DbSession = Depends(get_db)):
    """Called by the Windows agent. Authenticated by the shared node token, not a user session."""
    if not node_auth_ok(authorization):
        raise HTTPException(401, "Invalid node credentials")
    n = db.get(GpuNode, hb.node_id) or GpuNode(id=hb.node_id)
    n.status, n.gpu_name, n.vram_total_mb, n.vram_free_mb = hb.status, hb.gpu, hb.vram_total_mb, hb.vram_free_mb
    n.models, n.active_jobs = hb.models, hb.active_jobs
    n.last_heartbeat_at = datetime.now(timezone.utc)
    db.add(n)
    db.commit()
    return {"ok": True}


@router.get("/gpu/status")
def gpu_status(user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    s = get_settings()
    n = db.get(GpuNode, s.gpu_node_id)
    online = bool(n and n.status == "online" and n.last_heartbeat_at and
                  (datetime.now(timezone.utc) - n.last_heartbeat_at).total_seconds() < s.gpu_heartbeat_stale_s)
    # Counts are scoped to this user's own jobs.
    counts = dict(db.execute(select(Job.state, func.count()).where(
        Job.created_by == user.id, Job.requires_gpu.is_(True),
        Job.state.in_([S.QUEUED.value, S.WAITING_FOR_GPU.value, S.RUNNING.value, S.RETRYABLE.value]))
        .group_by(Job.state)).all())
    return {"online": online, "node_id": s.gpu_node_id, "gpu": n.gpu_name if n else None,
            "vram_free_mb": n.vram_free_mb if n else None, "models": n.models if n else [],
            "last_heartbeat_at": n.last_heartbeat_at.isoformat() if n and n.last_heartbeat_at else None,
            "queue": counts, "waiting": counts.get(S.WAITING_FOR_GPU.value, 0)}


@router.get("/providers/status")
def providers_status(user: User = Depends(current_user)):
    s = get_settings()
    return {"primary": s.llm_primary_provider, "fallback": s.llm_fallback_provider,
            "external_llm_monthly_budget_usd": s.external_llm_monthly_budget_usd,
            "embedding_provider": s.embedding_provider, "embedding_model": s.embedding_model,
            "models": {"fast": s.fast_model, "deep": s.deep_model, "critic": s.critic_model or s.fast_model,
                       "extraction": s.extraction_model or s.fast_model}}
