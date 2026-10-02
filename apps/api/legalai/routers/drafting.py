import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..db import get_db
from ..drafting.prompts import MODES
from ..jobs.queue import enqueue
from ..models import Document, DocumentChunk, Draft, Job, Redline, User
from ..review.diff import word_diff
from ..security import current_user, get_matter_access
from .review import _job_info, _status

router = APIRouter(prefix="/api", tags=["drafting"])
Mode = Literal[tuple(MODES)]  # type: ignore[valid-type]
Perspective = Literal["neutral", "customer", "vendor", "employer", "employee"]


class DraftRequest(BaseModel):
    matter_id: uuid.UUID
    mode: Mode = "draft_from_scratch"
    doc_type: str = Field("", max_length=100)
    instructions: str = Field(min_length=3, max_length=6000)
    facts: dict[str, str] = Field(default_factory=dict)
    jurisdiction: str = Field("", max_length=100)
    perspective: Perspective = "neutral"
    source_text: str = Field("", max_length=20000)
    chunk_id: uuid.UUID | None = None
    critic: bool = False


def draft_out(d: Draft, job: Job | None, full: bool = True) -> dict:
    out = {"id": str(d.id), "matter_id": str(d.matter_id), "mode": d.mode, "doc_type": d.doc_type, "instructions": d.instructions,
           "status": _status(d.status, job), "created_at": d.created_at.isoformat(), **_job_info(job)}
    if full:
        out |= {"content": d.content, "result": d.result, "model": d.model, "provider": d.provider, "prompt_version": d.prompt_version,
                "output_hash": d.output_hash, "inputs": d.inputs}
    return out


@router.post("/drafts", status_code=202)
def start_draft(body: DraftRequest, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    matter, _ = get_matter_access(db, user, body.matter_id, "editor")
    needs_source = body.mode not in ("draft_from_scratch", "add_missing")
    if needs_source and not (body.source_text or body.chunk_id):
        raise HTTPException(422, "This mode needs source text or a clause to work from")
    if body.chunk_id:
        c = db.get(DocumentChunk, body.chunk_id)
        if not c or c.matter_id != matter.id:
            raise HTTPException(404, "Clause not found")
    d = Draft(matter_id=matter.id, created_by=user.id, mode=body.mode, doc_type=body.doc_type, instructions=body.instructions,
              inputs={"facts": body.facts, "jurisdiction": body.jurisdiction, "perspective": body.perspective,
                      "source_text": body.source_text, "chunk_id": str(body.chunk_id) if body.chunk_id else None, "critic": body.critic})
    db.add(d)
    db.flush()
    job = enqueue(db, "draft", matter_id=matter.id, user_id=user.id, requires_gpu=True, payload={"draft_id": str(d.id)})
    d.job_id = job.id
    audit(db, "draft.requested", user_id=user.id, matter_id=matter.id, object_type="draft", object_id=d.id, mode=body.mode)
    db.commit()
    return draft_out(d, job, full=False)


@router.get("/drafts/{did}")
def get_draft(did: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    d = db.get(Draft, did)
    if not d:
        raise HTTPException(404, "Draft not found")
    get_matter_access(db, user, d.matter_id)
    return draft_out(d, db.get(Job, d.job_id) if d.job_id else None)


@router.get("/matters/{matter_id}/drafts")
def list_drafts(matter_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    get_matter_access(db, user, matter_id)
    rows = db.scalars(select(Draft).where(Draft.matter_id == matter_id).order_by(Draft.created_at.desc()).limit(50)).all()
    jobs = {j.id: j for j in db.scalars(select(Job).where(Job.id.in_([d.job_id for d in rows if d.job_id])))}
    return [draft_out(d, jobs.get(d.job_id), full=False) for d in rows]


# ---- redlines -------------------------------------------------------------------------------------------------
class RedlineRequest(BaseModel):
    chunk_id: uuid.UUID
    instruction: str = Field(min_length=3, max_length=2000)
    perspective: Perspective = "neutral"


class RedlinePatch(BaseModel):
    status: Literal["pending", "accepted", "rejected"]


def redline_out(r: Redline, job: Job | None = None) -> dict:
    return {"id": str(r.id), "document_id": str(r.document_id), "version_id": str(r.version_id), "chunk_id": str(r.chunk_id) if r.chunk_id else None,
            "clause_label": r.clause_label, "original": r.original, "proposed": r.proposed, "reason": r.reason, "risk": r.risk,
            "support": r.support, "status": r.status, "review_id": str(r.review_id) if r.review_id else None,
            "ops": word_diff(r.original, r.proposed) if r.proposed else None,
            "generation": _status("complete" if r.proposed else "queued", job), "created_at": r.created_at.isoformat(), **_job_info(job)}


@router.post("/redlines", status_code=202)
def create_redline(body: RedlineRequest, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    c = db.get(DocumentChunk, body.chunk_id)
    if not c:
        raise HTTPException(404, "Clause not found")
    get_matter_access(db, user, c.matter_id, "editor")
    doc = db.get(Document, c.document_id)
    r = Redline(matter_id=c.matter_id, document_id=c.document_id, version_id=c.version_id, chunk_id=c.id,
                clause_label=" > ".join(c.heading_path) or c.section_number, original=c.text, created_by=user.id,
                support={"instruction": body.instruction, "perspective": body.perspective})
    db.add(r)
    db.flush()
    job = enqueue(db, "redline_generation", matter_id=c.matter_id, user_id=user.id, requires_gpu=True, payload={"redline_id": str(r.id)})
    r.job_id = job.id
    audit(db, "redline.requested", user_id=user.id, matter_id=c.matter_id, object_type="redline", object_id=r.id, document=doc.title)
    db.commit()
    return redline_out(r, job)


@router.get("/redlines/{rid}")
def get_redline(rid: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    r = db.get(Redline, rid)
    if not r:
        raise HTTPException(404, "Redline not found")
    get_matter_access(db, user, r.matter_id)
    return redline_out(r, db.get(Job, r.job_id) if r.job_id else None)


@router.patch("/redlines/{rid}")
def patch_redline(rid: uuid.UUID, body: RedlinePatch, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    r = db.get(Redline, rid)
    if not r:
        raise HTTPException(404, "Redline not found")
    get_matter_access(db, user, r.matter_id, "editor")
    r.status = body.status
    audit(db, "redline.status", user_id=user.id, matter_id=r.matter_id, object_type="redline", object_id=r.id, status=body.status)
    db.commit()
    return redline_out(r)


@router.get("/matters/{matter_id}/redlines")
def list_redlines(matter_id: uuid.UUID, document_id: uuid.UUID | None = None, user: User = Depends(current_user),
                  db: DbSession = Depends(get_db)):
    get_matter_access(db, user, matter_id)
    q = select(Redline).where(Redline.matter_id == matter_id)
    if document_id:
        q = q.where(Redline.document_id == document_id)
    rows = db.scalars(q.order_by(Redline.created_at.desc()).limit(200)).all()
    jobs = {j.id: j for j in db.scalars(select(Job).where(Job.id.in_([r.job_id for r in rows if r.job_id])))}
    return [redline_out(r, jobs.get(r.job_id)) for r in rows]
