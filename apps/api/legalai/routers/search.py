import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from ..audit import audit
from ..config import get_settings
from ..db import get_db
from ..models import Document, DocumentChunk, DocumentVersion, User
from ..retrieval.hybrid import hybrid_search
from ..security import current_user, get_matter_access

router = APIRouter(prefix="/api", tags=["search"])


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=2000)
    k: int = Field(8, ge=1, le=30)
    mode: Literal["hybrid", "semantic", "lexical"] = "hybrid"


def chunk_out(c: DocumentChunk, title: str, version_number: int) -> dict:
    return {"chunk_id": str(c.id), "document_id": str(c.document_id), "version_id": str(c.version_id),
            "document_title": title, "version_number": version_number, "page": c.page, "page_end": c.page_end,
            "heading_path": c.heading_path, "section_number": c.section_number,
            "char_start": c.char_start, "char_end": c.char_end, "text": c.text}


@router.post("/matters/{matter_id}/search")
async def search(matter_id: uuid.UUID, body: SearchRequest, user: User = Depends(current_user),
                 db: DbSession = Depends(get_db)):
    matter, _ = get_matter_access(db, user, matter_id)
    r = await hybrid_search(db, matter, body.query, get_settings(), k=body.k, mode=body.mode)
    audit(db, "retrieval.search", user_id=user.id, matter_id=matter.id, object_type="matter", object_id=matter.id,
          query=body.query, mode=r.mode_used, embedding_model=r.embedding_model,
          chunk_ids=[str(h.chunk.id) for h in r.hits])
    db.commit()
    return {"hits": [{**chunk_out(h.chunk, h.document_title, h.version_number), "cite_id": h.cite_id,
                      "score": round(h.score, 5), "semantic_rank": h.sem_rank, "lexical_rank": h.lex_rank}
                     for h in r.hits],
            "warnings": r.warnings, "embedding_model": r.embedding_model, "mode": r.mode_used}


@router.get("/chunks/{chunk_id}")
def get_chunk(chunk_id: uuid.UUID, context: int = 700, user: User = Depends(current_user),
              db: DbSession = Depends(get_db)):
    """Open the exact source location of a citation, with surrounding text."""
    c = db.get(DocumentChunk, chunk_id)
    if not c:
        raise HTTPException(404, "Passage not found")
    get_matter_access(db, user, c.matter_id)
    doc, ver = db.get(Document, c.document_id), db.get(DocumentVersion, c.version_id)
    ctx = min(max(context, 0), 3000)
    full = ver.extracted_text or ""
    return {**chunk_out(c, doc.title, ver.version_number),
            "before": full[max(0, c.char_start - ctx):c.char_start], "after": full[c.char_end:c.char_end + ctx],
            "is_current_version": doc.current_version_id == ver.id}
