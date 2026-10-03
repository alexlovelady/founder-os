import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from .. import storage
from ..audit import audit
from ..db import get_db
from ..drafting.revise import Item, plan, render
from ..jobs.queue import enqueue
from ..models import ContractReview, Document, DocumentChunk, DocumentVersion, Redline, User
from ..scanning import scan_upload
from ..security import current_user, get_matter_access

router = APIRouter(prefix="/api/documents", tags=["revise"])


class ReviseRequest(BaseModel):
    version_id: uuid.UUID | None = None
    redline_ids: list[uuid.UUID] | None = Field(None, max_length=200)  # default: all accepted redlines
    include_pending: bool = False                                          # also apply suggestions you have not decided on
    format: Literal["docx", "tracked_docx", "txt", "md"] = "tracked_docx"
    save_as_version: bool = False


def _collect(db: DbSession, user: User, doc_id: uuid.UUID, body: ReviseRequest):
    doc = db.get(Document, doc_id)
    if not doc or doc.deleted_at:
        raise HTTPException(404, "Document not found")
    matter, _ = get_matter_access(db, user, doc.matter_id, "editor")
    ver = db.get(DocumentVersion, body.version_id or doc.current_version_id)
    if not ver or ver.document_id != doc.id:
        raise HTTPException(404, "Version not found")
    if ver.parse_status != "parsed" or not ver.extracted_text:
        raise HTTPException(409, f"Document is not ready (status: {ver.parse_status})")
    q = select(Redline).where(Redline.document_id == doc.id, Redline.version_id == ver.id, Redline.proposed.isnot(None))
    if body.redline_ids is not None:
        q = q.where(Redline.id.in_(body.redline_ids))
    else:
        q = q.where(Redline.status.in_(["accepted", "pending"] if body.include_pending else ["accepted"]))
    rows = db.scalars(q.order_by(Redline.created_at)).all()
    items, skipped = [], []
    for r in rows:
        if r.status == "rejected" and body.redline_ids is None:
            continue
        c = db.get(DocumentChunk, r.chunk_id) if r.chunk_id else None
        if c and c.version_id == ver.id:
            start, end = c.char_start, c.char_end
        else:
            start = ver.extracted_text.find(r.original)
            end = start + len(r.original)
            if start < 0 or ver.extracted_text.count(r.original) != 1:
                skipped.append({"redline_id": str(r.id), "label": r.clause_label, "reason": "Could not locate this clause in the document"})
                continue
        items.append(Item(str(r.id), r.clause_label, r.original, r.proposed, start, end))
    res = plan(ver.extracted_text, items)
    res.skipped += skipped
    pending = db.scalar(select(func.count()).select_from(Redline).where(
        Redline.document_id == doc.id, Redline.version_id == ver.id, Redline.status == "pending", Redline.proposed.isnot(None))) or 0
    manual = []
    rv = db.scalar(select(ContractReview).where(ContractReview.version_id == ver.id, ContractReview.status == "complete")
                   .order_by(ContractReview.created_at.desc()).limit(1))
    if rv and rv.result:
        manual = [{"id": i["id"], "title": i["title"], "risk": i["risk"], "why": i["why"], "basis": i["basis"], "clauses": i["clauses"]}
                  for i in rv.result.get("issues", []) if not i.get("suggested_revision")]
    return doc, ver, res, pending, manual


@router.post("/{doc_id}/revise/preview")
def preview(doc_id: uuid.UUID, body: ReviseRequest, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    doc, ver, res, pending, manual = _collect(db, user, doc_id, body)
    return {"applied": [{"redline_id": i.redline_id, "label": i.label, "original": i.original, "proposed": i.proposed} for i in res.applied],
            "skipped": res.skipped, "pending_not_applied": 0 if body.include_pending else pending,
            "needs_manual_drafting": manual, "revised_chars": len(res.revised_text), "original_chars": len(ver.extracted_text or ""),
            "preserves_formatting": doc is not None and ver.original_filename.lower().endswith(".docx")}


@router.post("/{doc_id}/revise")
def revise(doc_id: uuid.UUID, body: ReviseRequest, user: User = Depends(current_user), db: DbSession = Depends(get_db)):
    doc, ver, res, pending, manual = _collect(db, user, doc_id, body)
    if not res.applied:
        raise HTTPException(409, "No redlines to apply. Accept some suggestions first, or include pending ones.")
    original = storage.get_storage().get(ver.storage_key) if ver.original_filename.lower().endswith(".docx") else None
    data, filename, mtype = render(body.format, full_text=ver.extracted_text, res=res, original=original,
                                   original_name=ver.original_filename, title=doc.title)
    audit(db, "document.revised", user_id=user.id, matter_id=doc.matter_id, object_type="document", object_id=doc.id,
          source_version=str(ver.id), format=body.format, applied=[i.redline_id for i in res.applied], skipped=len(res.skipped),
          save_as_version=body.save_as_version)
    if not body.save_as_version:
        db.commit()
        return Response(data, media_type=mtype, headers={
            "Content-Disposition": f'attachment; filename="{storage.sanitize_filename(filename)}"', "X-Content-Type-Options": "nosniff",
            "X-Revise-Applied": str(len(res.applied)), "X-Revise-Skipped": str(len(res.skipped))})
    fname = storage.sanitize_filename(filename)
    try:
        ctype = storage.validate_upload(fname, data)
        scan_upload(fname, data)
    except storage.UploadRejected as e:
        raise HTTPException(500, f"Generated file failed validation: {e}")
    ver_id = uuid.uuid4()
    key = f"matters/{doc.matter_id}/documents/{doc.id}/{ver_id}/{fname}"
    storage.get_storage().put(key, data)
    number = (db.scalar(select(func.max(DocumentVersion.version_number)).where(DocumentVersion.document_id == doc.id)) or 0) + 1
    nv = DocumentVersion(id=ver_id, document_id=doc.id, version_number=number, original_filename=fname, content_type=ctype,
                         size_bytes=len(data), sha256=storage.sha256_hex(data), storage_key=key, uploaded_by=user.id)
    db.add(nv)
    db.flush()
    doc.current_version_id = nv.id
    job = enqueue(db, "ingest_document", matter_id=doc.matter_id, user_id=user.id, payload={"document_id": str(doc.id), "version_id": str(nv.id)})
    db.commit()
    return {"saved": True, "version_id": str(nv.id), "version_number": number, "filename": fname, "job_id": str(job.id),
            "applied": len(res.applied), "skipped": res.skipped}
