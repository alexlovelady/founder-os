import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..db import get_db
from ..jobs.queue import enqueue
from ..quota import consume_ai_quota
from ..models import (Comparison, ContractReview, Document, DocumentChunk, DocumentVersion, Job, Obligation, Playbook, User)
from ..review.diff import compare_clauses
from ..review.pipeline import BUILTIN_PLAYBOOKS
from ..security import current_user, get_matter_access

router = APIRouter(prefix="/api", tags=["review"])
PERSPECTIVES = Literal["neutral", "customer", "vendor", "employer", "employee"]


def _status(base: str, job: Job | None) -> str:
    if base == "queued" and job and job.state in ("FAILED", "CANCELED"):
        return job.state.lower()
    return base


def _job_info(job: Job | None) -> dict:
    return {"job_id": str(job.id) if job else None, "job_state": job.state if job else None,
            "status_message": job.status_message if job else "", "error": job.error if job and job.state == "FAILED" else None,
            "needs_fallback_approval": bool(job and job.needs_fallback_approval)}


# ---- playbooks ------------------------------------------------------------------------------------------------
class Rule(BaseModel):
    topic: str = Field(max_length=100)
    preferred: str = Field("", max_length=1000)
    fallback: str = Field("", max_length=1000)
    red_flags: str = Field("", max_length=1000)
    severity: Literal["critical", "high", "medium", "low"] = "medium"


class PlaybookIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    perspective: PERSPECTIVES = "neutral"
    rules: list[Rule] = Field(default_factory=list, max_length=60)


def _pb_out(p: Playbook) -> dict:
    return {"id": str(p.id), "name": p.name, "description": p.description, "perspective": p.perspective, "rules": p.rules, "builtin": False}


@router.get("/playbooks")
def list_playbooks(user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    mine = db.scalars(select(Playbook).where(Playbook.owner_id == user.id).order_by(Playbook.name)).all()
    builtin = [{"id": k, "name": v["name"], "description": "", "perspective": v["perspective"], "rules": v["rules"], "builtin": True}
               for k, v in BUILTIN_PLAYBOOKS.items()]
    return builtin + [_pb_out(p) for p in mine]


@router.post("/playbooks", status_code=201)
def create_playbook(body: PlaybookIn, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    p = Playbook(owner_id=user.id, name=body.name, description=body.description, perspective=body.perspective,
                 rules=[r.model_dump() for r in body.rules])
    db.add(p)
    db.commit()
    return _pb_out(p)


@router.delete("/playbooks/{pid}")
def delete_playbook(pid: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    p = db.get(Playbook, pid)
    if not p or p.owner_id != user.id:
        raise HTTPException(404, "Playbook not found")
    db.delete(p)
    db.commit()
    return {"ok": True}


# ---- contract review ------------------------------------------------------------------------------------------
class ReviewRequest(BaseModel):
    document_id: uuid.UUID
    version_id: uuid.UUID | None = None
    playbook_id: str | None = None
    perspective: PERSPECTIVES = "neutral"
    critic: bool = False


def review_out(r: ContractReview, job: Job | None, full: bool = True) -> dict:
    out = {"id": str(r.id), "matter_id": str(r.matter_id), "document_id": str(r.document_id), "version_id": str(r.version_id),
           "status": _status(r.status, job), "perspective": r.perspective, "created_at": r.created_at.isoformat(),
           **_job_info(job)}
    if r.result and r.status == "complete":
        out["risk_counts"] = r.result.get("risk_counts")
    if full:
        out |= {"result": r.result if r.status == "complete" else None, "provider": r.provider, "model": r.model,
                "prompt_version": r.prompt_version, "output_hash": r.output_hash}
    return out


@router.post("/contracts/review", status_code=202)
def start_review(body: ReviewRequest, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    doc = db.get(Document, body.document_id)
    if not doc or doc.deleted_at:
        raise HTTPException(404, "Document not found")
    matter, _ = get_matter_access(db, user, doc.matter_id, "editor")
    ver = db.get(DocumentVersion, body.version_id or doc.current_version_id)
    if not ver or ver.document_id != doc.id:
        raise HTTPException(404, "Version not found")
    if ver.parse_status != "parsed":
        raise HTTPException(409, f"Document is not ready for review (status: {ver.parse_status})")
    pb_id, builtin = None, None
    if body.playbook_id:
        if body.playbook_id in BUILTIN_PLAYBOOKS:
            builtin = body.playbook_id
        else:
            try:
                pb = db.get(Playbook, uuid.UUID(body.playbook_id))
            except ValueError:
                pb = None
            if not pb or pb.owner_id != user.id:
                raise HTTPException(404, "Playbook not found")
            pb_id = pb.id
    consume_ai_quota(user.id)  # one plan unit per review (the pipeline's own sub-steps are not counted again)
    rv = ContractReview(matter_id=matter.id, document_id=doc.id, version_id=ver.id, created_by=user.id, playbook_id=pb_id,
                        perspective=body.perspective, result={"builtin_playbook": builtin, "critic": body.critic})
    db.add(rv)
    db.flush()
    job = enqueue(db, "contract_review", matter_id=matter.id, user_id=user.id, requires_gpu=True, payload={"review_id": str(rv.id)})
    rv.job_id = job.id
    audit(db, "contract_review.requested", user_id=user.id, matter_id=matter.id, object_type="contract_review", object_id=rv.id,
          document_id=str(doc.id), version_id=str(ver.id), playbook=body.playbook_id, perspective=body.perspective)
    db.commit()
    return review_out(rv, job, full=False)


@router.get("/contracts/reviews/{rid}")
def get_review(rid: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    r = db.get(ContractReview, rid)
    if not r:
        raise HTTPException(404, "Review not found")
    get_matter_access(db, user, r.matter_id)
    return review_out(r, db.get(Job, r.job_id) if r.job_id else None)


@router.get("/matters/{matter_id}/contract-reviews")
def list_reviews(matter_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    get_matter_access(db, user, matter_id)
    rows = db.scalars(select(ContractReview).where(ContractReview.matter_id == matter_id)
                      .order_by(ContractReview.created_at.desc()).limit(50)).all()
    jobs = {j.id: j for j in db.scalars(select(Job).where(Job.id.in_([r.job_id for r in rows if r.job_id])))}
    docs = {d.id: d.title for d in db.scalars(select(Document).where(Document.id.in_([r.document_id for r in rows])))}
    return [{**review_out(r, jobs.get(r.job_id), full=False), "document_title": docs.get(r.document_id, "")} for r in rows]


# ---- obligations ----------------------------------------------------------------------------------------------
def ob_out(o: Obligation) -> dict:
    return {"id": str(o.id), "document_id": str(o.document_id), "party": o.party, "obligation": o.obligation, "trigger": o.trigger,
            "deadline_text": o.deadline_text, "deadline_date": o.deadline_date.isoformat() if o.deadline_date else None,
            "recurrence": o.recurrence, "source_chunk_id": str(o.source_chunk_id) if o.source_chunk_id else None,
            "source_clause": o.source_clause, "confidence": o.confidence, "status": o.status}


@router.get("/matters/{matter_id}/obligations")
def list_obligations(matter_id: uuid.UUID, status: str | None = None, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    get_matter_access(db, user, matter_id)
    q = select(Obligation).where(Obligation.matter_id == matter_id)
    if status:
        q = q.where(Obligation.status == status)
    rows = db.scalars(q.order_by(Obligation.deadline_date.asc().nulls_last(), Obligation.created_at)).all()
    return [ob_out(o) for o in rows]


class ObPatch(BaseModel):
    status: Literal["open", "done", "dismissed"]


@router.patch("/obligations/{oid}")
def patch_obligation(oid: uuid.UUID, body: ObPatch, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    o = db.get(Obligation, oid)
    if not o:
        raise HTTPException(404, "Obligation not found")
    get_matter_access(db, user, o.matter_id, "editor")
    o.status = body.status
    audit(db, "obligation.updated", user_id=user.id, matter_id=o.matter_id, object_type="obligation", object_id=o.id, status=body.status)
    db.commit()
    return ob_out(o)


# ---- comparisons ----------------------------------------------------------------------------------------------
class CompareRequest(BaseModel):
    version_a: uuid.UUID
    version_b: uuid.UUID
    summarize: bool = False


def _clauses(db: DbSession, vid: uuid.UUID) -> list[dict]:
    rows = db.scalars(select(DocumentChunk).where(DocumentChunk.version_id == vid).order_by(DocumentChunk.chunk_index)).all()
    return [{"chunk_id": str(c.id), "text": c.text, "section": c.section_number, "heading_path": c.heading_path, "page": c.page} for c in rows]


def cmp_out(c: Comparison, job: Job | None, full: bool = True) -> dict:
    out = {"id": str(c.id), "version_a": str(c.version_a), "version_b": str(c.version_b), "created_at": c.created_at.isoformat(),
           "counts": c.result.get("counts"), "summary": c.summary, **({"summary_" + k: v for k, v in _job_info(job).items()} if job else {})}
    if full:
        out["result"] = c.result
    return out


@router.post("/comparisons", status_code=201)
def create_comparison(body: CompareRequest, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    va, vb = db.get(DocumentVersion, body.version_a), db.get(DocumentVersion, body.version_b)
    if not va or not vb:
        raise HTTPException(404, "Version not found")
    da, dbb = db.get(Document, va.document_id), db.get(Document, vb.document_id)
    if da.matter_id != dbb.matter_id:
        raise HTTPException(404, "Version not found")  # no comparing across matters
    get_matter_access(db, user, da.matter_id, "editor")
    for v in (va, vb):
        if v.parse_status != "parsed":
            raise HTTPException(409, f"A selected version is not parsed yet (status: {v.parse_status})")
    if body.summarize:
        consume_ai_quota(user.id)  # only the AI summary counts; the clause diff itself is not AI
    result = compare_clauses(_clauses(db, va.id), _clauses(db, vb.id))
    cmp = Comparison(matter_id=da.matter_id, version_a=va.id, version_b=vb.id, created_by=user.id, result=result)
    db.add(cmp)
    db.flush()
    job = None
    if body.summarize:
        job = enqueue(db, "compare_summary", matter_id=da.matter_id, user_id=user.id, requires_gpu=True,
                      payload={"comparison_id": str(cmp.id)})
        cmp.summary_job_id = job.id
    audit(db, "comparison.created", user_id=user.id, matter_id=da.matter_id, object_type="comparison", object_id=cmp.id,
          version_a=str(va.id), version_b=str(vb.id), counts=result["counts"])
    db.commit()
    return cmp_out(cmp, job)


@router.get("/comparisons/{cid}")
def get_comparison(cid: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    c = db.get(Comparison, cid)
    if not c:
        raise HTTPException(404, "Comparison not found")
    get_matter_access(db, user, c.matter_id)
    return cmp_out(c, db.get(Job, c.summary_job_id) if c.summary_job_id else None)


@router.get("/matters/{matter_id}/comparisons")
def list_comparisons(matter_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    get_matter_access(db, user, matter_id)
    rows = db.scalars(select(Comparison).where(Comparison.matter_id == matter_id).order_by(Comparison.created_at.desc()).limit(50)).all()
    return [cmp_out(c, None, full=False) for c in rows]
