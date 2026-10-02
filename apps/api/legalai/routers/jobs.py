import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..db import get_db
from ..jobs.queue import InvalidTransition, cancel, enqueue
from ..models import Job, User
from ..security import current_user, get_matter_access

router = APIRouter(prefix="/api", tags=["jobs"])


class Message(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class InferenceRequest(BaseModel):
    matter_id: uuid.UUID
    messages: list[Message] = Field(min_length=1)
    role: Literal["auto", "fast", "deep", "critic", "extraction"] = "auto"
    task: str = ""
    params: dict = {}


def job_out(j: Job) -> dict:
    return {"id": str(j.id), "job_type": j.job_type, "state": j.state, "status_message": j.status_message,
            "matter_id": str(j.matter_id) if j.matter_id else None, "attempts": j.attempts,
            "needs_fallback_approval": j.needs_fallback_approval, "provider_used": j.provider_used,
            "model_used": j.model_used, "result": j.result, "error": j.error,
            "created_at": j.created_at.isoformat(),
            "finished_at": j.finished_at.isoformat() if j.finished_at else None}


def _load(db: DbSession, user: User, job_id: uuid.UUID, role: str = "viewer") -> Job:
    j = db.get(Job, job_id)
    if not j:
        raise HTTPException(404, "Job not found")
    if j.matter_id:
        get_matter_access(db, user, j.matter_id, role)
    elif j.created_by != user.id:
        raise HTTPException(404, "Job not found")
    return j


@router.post("/inference", status_code=202)
def submit_inference(body: InferenceRequest, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    """Queue a generic LLM call. Substantive workflows (research, review) will build on the same path."""
    get_matter_access(db, user, body.matter_id, "editor")
    job = enqueue(db, "llm_complete", matter_id=body.matter_id, user_id=user.id, requires_gpu=True,
                  payload={"messages": [m.model_dump() for m in body.messages], "role": body.role,
                           "task": body.task, "params": body.params})
    db.commit()
    return job_out(job)


@router.get("/jobs/{job_id}")
def get_job(job_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    return job_out(_load(db, user, job_id))


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    j = _load(db, user, job_id, "editor")
    try:
        cancel(db, j, user.id)
    except InvalidTransition as e:
        raise HTTPException(409, str(e))
    db.commit()
    return job_out(j)


@router.post("/jobs/{job_id}/approve-fallback")
def approve_fallback(job_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    """Per-job consent for matters whose fallback mode is 'ask'. Does nothing for 'disabled' matters."""
    j = _load(db, user, job_id, "owner")
    j.fallback_approved = True
    audit(db, "job.fallback_approved", user_id=user.id, matter_id=j.matter_id, object_type="job", object_id=j.id)
    db.commit()
    return job_out(j)
