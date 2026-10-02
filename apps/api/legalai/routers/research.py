import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..db import get_db
from ..jobs.queue import enqueue
from ..models import Job, ResearchRun, User
from ..security import current_user, get_matter_access

router = APIRouter(prefix="/api", tags=["research"])


class ResearchRequest(BaseModel):
    matter_id: uuid.UUID
    question: str = Field(min_length=3, max_length=4000)
    jurisdiction: str = Field("", max_length=100)
    as_of: date | None = None
    require_current: bool = False
    depth: Literal["auto", "fast", "deep"] = "auto"


def run_out(r: ResearchRun, job: Job | None, full: bool = True) -> dict:
    status = r.status
    if status == "queued" and job and job.state in ("FAILED", "CANCELED"):
        status = job.state.lower()
    base = {"id": str(r.id), "matter_id": str(r.matter_id), "question": r.question, "jurisdiction": r.jurisdiction,
            "as_of": r.as_of.isoformat() if r.as_of else None, "status": status, "job_id": str(r.job_id) if r.job_id else None,
            "job_state": job.state if job else None, "status_message": job.status_message if job else "",
            "error": job.error if job and job.state == "FAILED" else None,
            "needs_fallback_approval": bool(job and job.needs_fallback_approval),
            "created_at": r.created_at.isoformat(), "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "validation": r.validation}
    if full:
        base |= {"answer": r.answer, "result": r.result, "retrieval": r.retrieval, "provider": r.provider,
                 "model": r.model, "prompt_version": r.prompt_version, "privacy_mode": r.privacy_mode,
                 "output_hash": r.output_hash}
    return base


@router.post("/research", status_code=202)
def start_research(body: ResearchRequest, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    matter, _ = get_matter_access(db, user, body.matter_id, "editor")
    run = ResearchRun(matter_id=matter.id, created_by=user.id, question=body.question.strip(),
                      jurisdiction=body.jurisdiction.strip(), as_of=body.as_of or matter.relevant_date,
                      depth=body.depth, privacy_mode=matter.privacy_mode,
                      retrieval={"require_current": body.require_current})
    db.add(run)
    db.flush()
    job = enqueue(db, "research", matter_id=matter.id, user_id=user.id, requires_gpu=True,
                  payload={"run_id": str(run.id)})
    run.job_id = job.id
    audit(db, "research.requested", user_id=user.id, matter_id=matter.id, object_type="research_run",
          object_id=run.id, question=run.question, jurisdiction=run.jurisdiction, as_of=str(run.as_of))
    db.commit()
    return run_out(run, job)


@router.get("/research/{run_id}")
def get_run(run_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    r = db.get(ResearchRun, run_id)
    if not r:
        raise HTTPException(404, "Research run not found")
    get_matter_access(db, user, r.matter_id)
    return run_out(r, db.get(Job, r.job_id) if r.job_id else None)


@router.get("/matters/{matter_id}/research")
def list_runs(matter_id: uuid.UUID, limit: int = 30, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    get_matter_access(db, user, matter_id)
    runs = db.scalars(select(ResearchRun).where(ResearchRun.matter_id == matter_id)
                      .order_by(ResearchRun.created_at.desc()).limit(min(limit, 100))).all()
    jobs = {j.id: j for j in db.scalars(select(Job).where(Job.id.in_([r.job_id for r in runs if r.job_id])))}
    return [run_out(r, jobs.get(r.job_id), full=False) for r in runs]
