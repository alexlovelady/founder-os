import uuid
from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..jobs.queue import enqueue
from ..models import Document, DocumentVersion, User
from ..security import current_user, get_matter_access
from .. import storage

router = APIRouter(prefix="/api", tags=["documents"])


def authority_out(d: Document) -> dict:
    iso = lambda x: x.isoformat() if x else None
    return {"authority_type": d.authority_type, "jurisdiction": d.jurisdiction, "court": d.court,
            "court_level": d.court_level, "citation": d.citation_text, "document_date": iso(d.document_date),
            "effective_from": iso(d.effective_from), "effective_to": iso(d.effective_to),
            "precedential_status": d.precedential_status, "source_url": d.source_url,
            "official_source": d.official_source, "superseded": d.superseded, "metadata_source": d.metadata_source}


def _ver_out(v: DocumentVersion) -> dict:
    return {"id": str(v.id), "version_number": v.version_number, "filename": v.original_filename,
            "content_type": v.content_type, "size_bytes": v.size_bytes, "sha256": v.sha256, "status": v.status,
            "parse_status": v.parse_status, "parse_error": v.parse_error, "page_count": v.page_count,
            "embed_status": v.embed_status, "embedding_model": v.embedding_model,
            "created_at": v.created_at.isoformat()}


def _doc_out(d: Document, v: DocumentVersion | None) -> dict:
    return {"id": str(d.id), "matter_id": str(d.matter_id), "title": d.title, "doc_type": d.doc_type,
            "authority": authority_out(d),
            "current_version": _ver_out(v) if v else None}


@router.post("/documents", status_code=201)
async def upload_document(matter_id: uuid.UUID = Form(...), file: UploadFile = File(...),
                          title: str | None = Form(None), document_id: uuid.UUID | None = Form(None),
                          user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    """Upload a new document, or a new version of `document_id`."""
    get_matter_access(db, user, matter_id, "editor")
    limit = get_settings().max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"File exceeds {get_settings().max_upload_mb} MB limit")
    fname = storage.sanitize_filename(file.filename or "upload")
    try:
        ctype = storage.validate_upload(fname, data)
        storage.scanner.scan(data)
    except storage.UploadRejected as e:
        raise HTTPException(422, str(e))

    sha = storage.sha256_hex(data)
    if document_id:
        doc = db.get(Document, document_id)
        if not doc or doc.matter_id != matter_id or doc.deleted_at:
            raise HTTPException(404, "Document not found")
        next_no = (db.scalar(select(func.max(DocumentVersion.version_number))
                             .where(DocumentVersion.document_id == doc.id)) or 0) + 1
    else:
        doc = Document(matter_id=matter_id, title=title or fname)
        db.add(doc)
        db.flush()
        next_no = 1
    ver_id = uuid.uuid4()
    key = f"matters/{matter_id}/documents/{doc.id}/{ver_id}/{fname}"
    storage.get_storage().put(key, data)
    v = DocumentVersion(id=ver_id, document_id=doc.id, version_number=next_no, original_filename=fname,
                        content_type=ctype, size_bytes=len(data), sha256=sha, storage_key=key, uploaded_by=user.id)
    db.add(v)
    db.flush()
    doc.current_version_id = v.id
    job = enqueue(db, "ingest_document", matter_id=matter_id, user_id=user.id,
                  payload={"document_id": str(doc.id), "version_id": str(v.id)})
    audit(db, "document.uploaded", user_id=user.id, matter_id=matter_id, object_type="document",
          object_id=doc.id, version_id=str(v.id), sha256=sha, size_bytes=len(data), filename=fname)
    db.commit()
    return {**_doc_out(doc, v), "job_id": str(job.id)}


@router.get("/matters/{matter_id}/documents")
def list_documents(matter_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    get_matter_access(db, user, matter_id)
    docs = db.scalars(select(Document).where(Document.matter_id == matter_id, Document.deleted_at.is_(None))
                      .order_by(Document.created_at.desc())).all()
    return [_doc_out(d, db.get(DocumentVersion, d.current_version_id) if d.current_version_id else None)
            for d in docs]


def _load_doc(db: DbSession, user: User, document_id: uuid.UUID, role: str = "viewer") -> Document:
    d = db.get(Document, document_id)
    if not d or d.deleted_at:
        raise HTTPException(404, "Document not found")
    get_matter_access(db, user, d.matter_id, role)  # authorization on every object
    return d


@router.get("/documents/{document_id}")
def get_document(document_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    d = _load_doc(db, user, document_id)
    return _doc_out(d, db.get(DocumentVersion, d.current_version_id) if d.current_version_id else None)


@router.get("/documents/{document_id}/versions")
def list_versions(document_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    d = _load_doc(db, user, document_id)
    vs = db.scalars(select(DocumentVersion).where(DocumentVersion.document_id == d.id)
                    .order_by(DocumentVersion.version_number)).all()
    return [_ver_out(v) for v in vs]


@router.get("/documents/{document_id}/versions/{version_id}/download")
def download(document_id: uuid.UUID, version_id: uuid.UUID, user: User = Depends(current_user),
             db: DbSession = Depends(get_db)):
    d = _load_doc(db, user, document_id)
    v = db.get(DocumentVersion, version_id)
    if not v or v.document_id != d.id:
        raise HTTPException(404, "Version not found")
    audit(db, "document.downloaded", user_id=user.id, matter_id=d.matter_id, object_type="document",
          object_id=d.id, version_id=str(v.id))
    db.commit()
    return Response(storage.get_storage().get(v.storage_key), media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{v.original_filename}"',
                             "X-Content-Type-Options": "nosniff"})


@router.post("/documents/{document_id}/reindex", status_code=202)
def reindex(document_id: uuid.UUID, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    """Re-run parse, chunk and embed for the current version (e.g. after a parser improvement)."""
    d = _load_doc(db, user, document_id, "editor")
    if not d.current_version_id:
        raise HTTPException(409, "Document has no version")
    job = enqueue(db, "ingest_document", matter_id=d.matter_id, user_id=user.id,
                  payload={"document_id": str(d.id), "version_id": str(d.current_version_id)})
    audit(db, "document.reindex_requested", user_id=user.id, matter_id=d.matter_id, object_type="document",
          object_id=d.id)
    db.commit()
    return {"job_id": str(job.id)}


AUTHORITY_TYPES = ("user_document", "constitution", "statute", "regulation", "administrative_guidance", "court_opinion",
                   "court_rule", "agency_material", "official_form", "treatise", "template")


class AuthorityPatch(BaseModel):
    title: str | None = Field(None, max_length=500)
    doc_type: str | None = Field(None, max_length=50)
    authority_type: Literal[AUTHORITY_TYPES] | None = None
    jurisdiction: str | None = Field(None, max_length=100)
    court: str | None = Field(None, max_length=200)
    court_level: Literal["", "supreme", "appellate", "trial", "agency"] | None = None
    citation: str | None = Field(None, max_length=300)
    document_date: date | None = None
    effective_from: date | None = None
    effective_to: date | None = None
    precedential_status: Literal["", "precedential", "non_precedential"] | None = None
    source_url: str | None = Field(None, max_length=1000)
    official_source: bool | None = None
    superseded: bool | None = None


@router.patch("/documents/{document_id}/authority")
def patch_authority(document_id: uuid.UUID, body: AuthorityPatch, user: User = Depends(current_user),
                    db: DbSession = Depends(get_db)):
    d = _load_doc(db, user, document_id, "editor")
    changes = body.model_dump(exclude_unset=True)
    for k, v in changes.items():
        if v is None:
            if k in ("official_source", "superseded"):
                continue
            v = None if k in ("document_date", "effective_from", "effective_to") else ""
        setattr(d, "citation_text" if k == "citation" else k, v)
    d.metadata_source = "user"
    audit(db, "document.authority_updated", user_id=user.id, matter_id=d.matter_id, object_type="document",
          object_id=d.id, fields=sorted(changes))
    db.commit()
    return _doc_out(d, db.get(DocumentVersion, d.current_version_id) if d.current_version_id else None)
