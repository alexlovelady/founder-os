import uuid

from sqlalchemy import delete, select, insert

from ..audit import audit
from ..config import Settings
from ..db import session_scope
from ..jobs.queue import enqueue
from ..models import (ChunkEmbedding, Document, DocumentChunk, DocumentVersion, Matter, ProviderUsage)
from ..privacy import (assert_embedding_budget, assert_external_embedding_allowed, embedding_model_id,
                       embedding_route)
from ..providers.embeddings import build_embedding_provider
from ..storage import get_storage, sha256_hex
from .chunking import Chunk, chunk_document
from .detect import AUTHORITY_FOR_CLASS, classify, detect_date, detect_jurisdiction
from .parsers import NeedsOcr, ParseError, parse_document


def _enqueue_embed(db, matter: Matter, version_id: uuid.UUID, settings: Settings, user_id=None):
    if matter.kind == "library":
        # Public text is embedded under BOTH models so private/local-only matters (local vectors) can search it too.
        jobs = []
        if settings.embedding_provider == "external" and settings.embedding_api_key:
            jobs.append(enqueue(db, "embed_document", matter_id=matter.id, user_id=user_id,
                                payload={"version_id": str(version_id), "route": "external"}, requires_gpu=False))
        jobs.append(enqueue(db, "embed_document", matter_id=matter.id, user_id=user_id,
                            payload={"version_id": str(version_id), "route": "local"}, requires_gpu=True))
        return jobs[0]
    route = embedding_route(matter, settings)
    return enqueue(db, "embed_document", matter_id=matter.id, user_id=user_id,
                   payload={"version_id": str(version_id)}, requires_gpu=(route == "local"))


def enqueue_embeddings_for_matter(db, matter: Matter, settings: Settings, user_id=None) -> int:
    """Used when a matter's embedding route changes (privacy mode switch): re-embed current versions."""
    n = 0
    docs = db.scalars(select(Document).where(Document.matter_id == matter.id, Document.deleted_at.is_(None))).all()
    for d in docs:
        v = db.get(DocumentVersion, d.current_version_id) if d.current_version_id else None
        if v and v.parse_status == "parsed" and v.embedding_model != embedding_model_id(matter, settings):
            v.embed_status = "pending"
            _enqueue_embed(db, matter, v.id, settings, user_id)
            n += 1
    return n


def ingest_version(version_id: uuid.UUID, settings: Settings) -> dict:
    """Verify -> parse -> chunk -> store chunks with anchors -> queue embedding."""
    with session_scope() as db:
        v = db.get(DocumentVersion, version_id)
        doc = db.get(Document, v.document_id)
        matter = db.get(Matter, doc.matter_id)
        data = get_storage().get(v.storage_key)
        if sha256_hex(data) != v.sha256:
            v.status, v.parse_status, v.parse_error = "rejected", "failed", "Stored file hash mismatch"
            raise RuntimeError("Stored file hash does not match recorded SHA-256")
        v.status = "verified"
        try:
            parsed = parse_document(v.original_filename, data)
        except NeedsOcr as e:
            v.parse_status, v.parse_error = "needs_ocr", str(e)
            audit(db, "document.needs_ocr", matter_id=matter.id, object_type="document", object_id=doc.id)
            return {"sha256_verified": True, "parse_status": "needs_ocr"}
        except ParseError as e:
            v.parse_status, v.parse_error = "failed", str(e)[:500]
            return {"sha256_verified": True, "parse_status": "failed", "error": str(e)[:200]}
        chunks = chunk_document(parsed)
        db.execute(delete(DocumentChunk).where(DocumentChunk.version_id == v.id))
        v.extracted_text, v.page_count = parsed.text, parsed.page_count
        v.parse_status, v.parse_error, v.embed_status, v.embedding_model = "parsed", None, "pending", None
        if doc.metadata_source == "detected":  # never overwrite what the user entered
            doc.doc_type = classify(parsed.text)
            doc.authority_type = AUTHORITY_FOR_CLASS[doc.doc_type]
            doc.jurisdiction = detect_jurisdiction(parsed.text)
            doc.document_date = detect_date(parsed.text)
        if chunks:
            db.execute(insert(DocumentChunk), [
                dict(id=uuid.uuid4(), matter_id=matter.id, document_id=doc.id, version_id=v.id, chunk_index=c.index,
                     text=c.text, text_hash=c.text_hash, page=c.page, page_end=c.page_end,
                     heading_path=c.heading_path, section_number=c.section_number,
                     char_start=c.start, char_end=c.end) for c in chunks])
            _enqueue_embed(db, matter, v.id, settings)
        else:
            v.embed_status = "embedded"
        audit(db, "document.parsed", matter_id=matter.id, object_type="document", object_id=doc.id,
              version_id=str(v.id), chunks=len(chunks), pages=parsed.page_count)
        return {"sha256_verified": True, "parse_status": "parsed", "chunks": len(chunks)}


async def embed_version(version_id: uuid.UUID, settings: Settings, provider=None, route_override: str | None = None) -> dict:
    # Phase 1: decide route, find chunks that still need vectors, reuse cached vectors for identical inputs.
    with session_scope() as db:
        v = db.get(DocumentVersion, version_id)
        matter = db.get(Matter, db.get(Document, v.document_id).matter_id)
        route = route_override or embedding_route(matter, settings)
        model_id = (f"voyage:{settings.embedding_model}" if route == "external" else f"local:{settings.local_embedding_model}")
        if route == "external" and not settings.embedding_api_key:
            return {"skipped": "no external embedding key configured"}
        if route == "external":
            assert_external_embedding_allowed(matter)  # defense in depth; fails the job rather than leaking
            assert_embedding_budget(db, settings)
        have = set(db.scalars(select(ChunkEmbedding.chunk_id).join(DocumentChunk, DocumentChunk.id == ChunkEmbedding.chunk_id)
                              .where(DocumentChunk.version_id == v.id, ChunkEmbedding.model == model_id)))
        todo = []
        for c in db.scalars(select(DocumentChunk).where(DocumentChunk.version_id == v.id)
                            .order_by(DocumentChunk.chunk_index)):
            if c.id in have:
                continue
            inp = Chunk(c.chunk_index, c.text, c.char_start, c.char_end, c.page, c.page_end, c.heading_path,
                        c.section_number).embedding_input()
            todo.append((c.id, sha256_hex(inp.encode()), inp))
        cached = {}
        if todo:
            for h, vec in db.execute(select(ChunkEmbedding.text_hash, ChunkEmbedding.embedding).where(
                    ChunkEmbedding.model == model_id, ChunkEmbedding.text_hash.in_({t[1] for t in todo}))):
                cached[h] = vec
        matter_id = matter.id
    fresh = [t for t in todo if t[1] not in cached]
    vectors: dict[str, list[float]] = {}
    tokens = 0
    if fresh:
        provider = provider or build_embedding_provider(settings, external=(route == "external"))
        uniq = {t[1]: t[2] for t in fresh}
        keys = list(uniq)
        vecs = await provider.embed_documents([uniq[k] for k in keys])
        vectors = dict(zip(keys, vecs))
        tokens = getattr(provider, "tokens_used", 0)
    # Phase 2: write.
    with session_scope() as db:
        live = set(db.scalars(select(DocumentChunk.id).where(DocumentChunk.version_id == version_id)))
        rows = [dict(chunk_id=cid, model=model_id, text_hash=h, embedding=cached.get(h) if h in cached else vectors[h])
                for cid, h, _ in todo if cid in live]
        if rows:
            db.execute(insert(ChunkEmbedding), rows)
        v = db.get(DocumentVersion, version_id)
        v.embed_status, v.embedding_model = "embedded", model_id
        if route == "external" and tokens:
            db.add(ProviderUsage(matter_id=matter_id, provider="voyage", kind="embedding", model=settings.embedding_model,
                                 external=True, prompt_tokens=tokens,
                                 cost_usd=tokens / 1e6 * settings.embedding_price_per_1m_tokens_usd))
        audit(db, "document.embedded", matter_id=matter_id, object_type="document", object_id=v.document_id,
              version_id=str(version_id), model=model_id, embedded=len(fresh), reused=len(todo) - len(fresh))
    return {"model": model_id, "embedded": len(fresh), "reused_from_cache": len(todo) - len(fresh)}
