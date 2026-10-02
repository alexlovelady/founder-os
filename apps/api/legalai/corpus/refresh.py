"""Corpus refresh (spec section 29): check source -> hash -> detect change -> new version -> close the prior
version's effective range -> re-ingest (and re-embed) only what changed -> keep history for dated questions."""
import uuid
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import func, select

from ..audit import audit
from ..config import Settings
from ..db import session_scope
from ..jobs.queue import enqueue
from ..models import CorpusSource, Document, DocumentVersion, Job, Matter, PrivacyMode
from ..storage import get_storage, sha256_hex
from .adapters import SourceError, build_adapter

LIBRARY_NAME = "Authority Library"


def get_library_matter(db) -> Matter:
    m = db.scalar(select(Matter).where(Matter.kind == "library"))
    if not m:
        m = Matter(name=LIBRARY_NAME, description="Shared public legal authorities", kind="library",
                   privacy_mode=PrivacyMode.standard.value, external_embedding_enabled=True)
        db.add(m)
        db.flush()
    return m


async def refresh_source(source_id: uuid.UUID, settings: Settings, adapter=None) -> dict:
    with session_scope() as db:
        src = db.get(CorpusSource, source_id)
        if not src or not src.enabled:
            return {"status": "skipped"}
        name, cfg, etag, doc_id = src.adapter, dict(src.config), src.etag, src.document_id
        cur_hash = None
        if doc_id:
            d = db.get(Document, doc_id)
            v = db.get(DocumentVersion, d.current_version_id) if d and d.current_version_id else None
            cur_hash = v.sha256 if v else None
    try:
        res = await (adapter or build_adapter(name)).run(cfg, etag)
    except SourceError as e:
        with session_scope() as db:
            s = db.get(CorpusSource, source_id)
            s.last_checked_at, s.last_status = datetime.now(timezone.utc), f"error: {e}"[:300]
        raise
    now = datetime.now(timezone.utc)
    if res.unchanged or (res.content and sha256_hex(res.content) == cur_hash):
        with session_scope() as db:
            s = db.get(CorpusSource, source_id)
            s.last_checked_at, s.last_status = now, "unchanged"
            if res.etag:
                s.etag = res.etag
        return {"status": "unchanged"}

    with session_scope() as db:
        s = db.get(CorpusSource, source_id)
        lib = get_library_matter(db)
        doc = db.get(Document, s.document_id) if s.document_id else None
        if not doc:
            doc = Document(matter_id=lib.id, title=res.title or s.name, doc_type=("statute" if s.authority_type == "statute" else "regulation"
                                                                                    if s.authority_type == "regulation" else "other"),
                           authority_type=s.authority_type, jurisdiction=s.jurisdiction, citation_text=res.citation,
                           source_url=res.source_url, official_source=True, metadata_source="user")
            db.add(doc)
            db.flush()
            s.document_id = doc.id
        prev = db.get(DocumentVersion, doc.current_version_id) if doc.current_version_id else None
        number = (db.scalar(select(func.max(DocumentVersion.version_number)).where(DocumentVersion.document_id == doc.id)) or 0) + 1
        eff = res.effective_from or now.date()
        if prev and (prev.effective_to is None):
            prev.effective_to = eff - timedelta(days=1)
            if prev.effective_from is None:  # first dated version: it covered everything before this one
                prev.effective_from = date(1900, 1, 1)
        ver_id = uuid.uuid4()
        key = f"library/{doc.id}/{ver_id}/{res.filename}"
        get_storage().put(key, res.content)
        ver = DocumentVersion(id=ver_id, document_id=doc.id, version_number=number, original_filename=res.filename,
                              content_type="application/octet-stream", size_bytes=len(res.content), sha256=sha256_hex(res.content),
                              storage_key=key, uploaded_by=None, effective_from=eff, source_retrieved_at=res.retrieved_at or now)
        db.add(ver)
        db.flush()
        doc.current_version_id = ver.id
        doc.title, doc.citation_text, doc.source_url = res.title or doc.title, res.citation or doc.citation_text, res.source_url or doc.source_url
        s.last_checked_at = s.last_changed_at = now
        s.last_status = f"updated to version {number} (effective {eff})"
        s.etag = res.etag
        enqueue(db, "ingest_document", matter_id=lib.id, user_id=None, payload={"document_id": str(doc.id), "version_id": str(ver.id)})
        audit(db, "corpus.version_created", matter_id=lib.id, object_type="document", object_id=doc.id, source=str(s.id),
              version=number, sha256=ver.sha256, effective_from=str(eff), source_url=res.source_url)
        return {"status": "updated", "version": number, "document_id": str(doc.id)}


def enqueue_due_refreshes(settings: Settings) -> int:
    """Called periodically by the worker; one pending refresh per source at most."""
    n = 0
    with session_scope() as db:
        now = datetime.now(timezone.utc)
        for s in db.scalars(select(CorpusSource).where(CorpusSource.enabled.is_(True))):
            if s.last_checked_at and now - s.last_checked_at < timedelta(hours=s.refresh_hours):
                continue
            pending = db.scalar(select(func.count()).select_from(Job).where(
                Job.job_type == "corpus_refresh", Job.state.in_(["QUEUED", "RUNNING", "RETRYABLE", "WAITING_FOR_GPU"]),
                Job.payload["source_id"].astext == str(s.id)))
            if not pending:
                enqueue(db, "corpus_refresh", matter_id=None, user_id=None, payload={"source_id": str(s.id)}, max_attempts=3)
                n += 1
    return n
