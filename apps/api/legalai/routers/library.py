import uuid
from datetime import date as Date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..corpus.adapters import SourceError, validate_config
from ..corpus.refresh import get_library_matter
from ..db import get_db
from ..jobs.queue import enqueue
from ..models import CorpusSource, Document, DocumentVersion, User
from ..security import current_user, require_admin

router = APIRouter(prefix="/api/library", tags=["library"])
TREATMENT_TYPES = ("followed", "affirmed", "distinguished", "questioned", "criticized", "limited", "overruled", "reversed",
                   "vacated", "abrogated", "superseded_by", "repealed", "amended")


class SourceIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    adapter: Literal["ecfr", "url"]
    config: dict
    jurisdiction: str = Field("", max_length=100)
    authority_type: Literal["statute", "regulation", "court_opinion", "court_rule", "administrative_guidance", "agency_material",
                            "official_form", "constitution", "treatise"] = "regulation"
    refresh_hours: int = Field(24, ge=1, le=24 * 30)


class SourcePatch(BaseModel):
    enabled: bool | None = None
    refresh_hours: int | None = Field(None, ge=1, le=24 * 30)
    name: str | None = Field(None, max_length=300)


class Treatment(BaseModel):
    type: Literal[TREATMENT_TYPES]  # type: ignore[valid-type]
    citing: str = Field("", max_length=300)
    note: str = Field("", max_length=1000)
    date: Date | None = None
    source: str = Field("", max_length=500)


class TreatmentIn(BaseModel):
    treatment: list[Treatment] = Field(max_length=50)


def source_out(s: CorpusSource) -> dict:
    iso = lambda x: x.isoformat() if x else None
    return {"id": str(s.id), "name": s.name, "adapter": s.adapter, "config": s.config, "jurisdiction": s.jurisdiction,
            "authority_type": s.authority_type, "refresh_hours": s.refresh_hours, "enabled": s.enabled,
            "document_id": str(s.document_id) if s.document_id else None, "last_checked_at": iso(s.last_checked_at),
            "last_changed_at": iso(s.last_changed_at), "last_status": s.last_status}


@router.get("")
def list_library(user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    lib = get_library_matter(db)
    db.commit()
    docs = db.scalars(select(Document).where(Document.matter_id == lib.id, Document.deleted_at.is_(None)).order_by(Document.title)).all()
    counts = dict(db.execute(select(DocumentVersion.document_id, func.count()).where(
        DocumentVersion.document_id.in_([d.id for d in docs])).group_by(DocumentVersion.document_id)).all()) if docs else {}
    out = []
    for d in docs:
        v = db.get(DocumentVersion, d.current_version_id) if d.current_version_id else None
        out.append({"id": str(d.id), "title": d.title, "authority_type": d.authority_type, "jurisdiction": d.jurisdiction,
                    "citation": d.citation_text, "source_url": d.source_url, "official_source": d.official_source,
                    "versions": counts.get(d.id, 0), "current_version": v.version_number if v else None,
                    "effective_from": v.effective_from.isoformat() if v and v.effective_from else None,
                    "retrieved_at": v.source_retrieved_at.isoformat() if v and v.source_retrieved_at else None,
                    "parse_status": v.parse_status if v else None, "embed_status": v.embed_status if v else None,
                    "treatment": d.treatment or [], "library_matter_id": str(lib.id)})
    return {"documents": out, "library_matter_id": str(lib.id)}


@router.get("/sources")
def list_sources(admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    return [source_out(s) for s in db.scalars(select(CorpusSource).order_by(CorpusSource.name))]


@router.post("/sources", status_code=201)
def create_source(body: SourceIn, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    try:
        cfg = validate_config(body.adapter, body.config)
    except SourceError as e:
        raise HTTPException(422, str(e))
    s = CorpusSource(name=body.name, adapter=body.adapter, config=cfg, jurisdiction=body.jurisdiction,
                     authority_type=body.authority_type, refresh_hours=body.refresh_hours)
    db.add(s)
    db.flush()
    enqueue(db, "corpus_refresh", matter_id=None, user_id=admin.id, payload={"source_id": str(s.id)}, max_attempts=3)
    audit(db, "corpus.source_created", user_id=admin.id, object_type="corpus_source", object_id=s.id, adapter=body.adapter, config=cfg)
    db.commit()
    return source_out(s)


@router.patch("/sources/{sid}")
def patch_source(sid: uuid.UUID, body: SourcePatch, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    s = db.get(CorpusSource, sid)
    if not s:
        raise HTTPException(404, "Source not found")
    for k, v in body.model_dump(exclude_unset=True).items():
        if v is not None:
            setattr(s, k, v)
    audit(db, "corpus.source_updated", user_id=admin.id, object_type="corpus_source", object_id=s.id)
    db.commit()
    return source_out(s)


@router.delete("/sources/{sid}")
def delete_source(sid: uuid.UUID, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    s = db.get(CorpusSource, sid)
    if not s:
        raise HTTPException(404, "Source not found")
    db.delete(s)  # fetched documents and their versions stay (history is retained)
    audit(db, "corpus.source_deleted", user_id=admin.id, object_type="corpus_source", object_id=sid)
    db.commit()
    return {"ok": True}


@router.post("/sources/{sid}/refresh", status_code=202)
def refresh_now(sid: uuid.UUID, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    s = db.get(CorpusSource, sid)
    if not s:
        raise HTTPException(404, "Source not found")
    job = enqueue(db, "corpus_refresh", matter_id=None, user_id=admin.id, payload={"source_id": str(s.id)}, max_attempts=3)
    db.commit()
    return {"job_id": str(job.id)}


@router.put("/documents/{doc_id}/treatment")
def set_treatment(doc_id: uuid.UUID, body: TreatmentIn, admin: User = Depends(require_admin), db: DbSession = Depends(get_db)):
    """Record subsequent history (overruled, superseded, etc.) from an authoritative source. The system never infers it."""
    d = db.get(Document, doc_id)
    lib = get_library_matter(db)
    if not d or d.matter_id != lib.id:
        raise HTTPException(404, "Library document not found")
    d.treatment = [{**t.model_dump(), "date": t.date.isoformat() if t.date else None} for t in body.treatment]
    audit(db, "corpus.treatment_set", user_id=admin.id, matter_id=lib.id, object_type="document", object_id=d.id, count=len(d.treatment))
    db.commit()
    return {"treatment": d.treatment}
