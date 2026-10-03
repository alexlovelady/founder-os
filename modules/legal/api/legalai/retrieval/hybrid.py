"""Hybrid retrieval (spec section 14): semantic (pgvector) + lexical (Postgres FTS), fused with weighted
reciprocal-rank fusion, reranked, diversified, and packaged with citation IDs.

Authority metadata (jurisdiction, court level, superseded) joins the score in Phase 4 when authorities exist;
`authority_weight` is the hook. All weights come from Settings and are meant to be benchmarked."""
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Protocol

from sqlalchemy import and_, func, literal, or_, select
from sqlalchemy.orm import Session as DbSession

from ..config import Settings
from ..models import ChunkEmbedding, Document, DocumentChunk, DocumentVersion, Matter, ProviderUsage
from ..privacy import embedding_model_id, embedding_route
from ..providers.base import ProviderError, ProviderUnavailable
from ..providers.embeddings import build_embedding_provider
from .authority import AuthorityAssessment, assess

CANDIDATES = 50
EXACT = re.compile(r'\d|§|"|“')
WORD = re.compile(r"[A-Za-z0-9]{2,}")
STOP = {"the", "and", "for", "are", "was", "what", "which", "that", "this", "with", "from", "have", "has", "does",
        "how", "can", "may", "any", "not", "but", "its", "their", "there", "when", "who", "whom", "between"}


@dataclass
class Hit:
    chunk: DocumentChunk
    doc: Document
    version_number: int
    score: float = 0.0
    sem_rank: int | None = None
    lex_rank: int | None = None
    cite_id: str = ""
    authority: AuthorityAssessment = field(default_factory=AuthorityAssessment)
    retrieved_at: datetime | None = None
    effective_from: date | None = None
    ocr_applied: bool = False

    @property
    def document_title(self) -> str:
        return self.doc.title


@dataclass
class SearchResult:
    hits: list[Hit]
    warnings: list[str] = field(default_factory=list)
    embedding_model: str | None = None
    mode_used: str = "hybrid"


class Reranker(Protocol):
    def rerank(self, query: str, hits: list[Hit]) -> list[Hit]: ...


class NoopReranker:
    """Placeholder for a cross-encoder / API reranker. It must never drop controlling authority (spec section 11)."""

    def rerank(self, query: str, hits: list[Hit]) -> list[Hit]:
        return hits


def authority_weight(hit: Hit, settings: Settings) -> float:
    return hit.authority.bonus_units * settings.authority_scale / (settings.rrf_k + 1)


def _or_query(q: str) -> str:
    terms = [t.lower() for t in WORD.findall(q) if t.lower() not in STOP]
    return " | ".join(dict.fromkeys(terms))


def library_ids(db: DbSession) -> list:
    return list(db.scalars(select(Matter.id).where(Matter.kind == "library", Matter.deleted_at.is_(None))))


def _scope(matter_ids: list, as_of: date | None = None):
    """Chunks of this matter plus the shared public library. User documents: current version only. Library
    versions carry effective dates, so with `as_of` the version in force on that date is used (historical questions)."""
    current = Document.current_version_id == DocumentChunk.version_id
    if as_of is None:
        version_ok = current
    else:
        dated = and_(DocumentVersion.effective_from.isnot(None), DocumentVersion.effective_from <= as_of,
                     or_(DocumentVersion.effective_to.is_(None), DocumentVersion.effective_to >= as_of))
        version_ok = or_(dated, and_(current, DocumentVersion.effective_from.is_(None)))
    return and_(DocumentChunk.matter_id.in_(matter_ids), Document.id == DocumentChunk.document_id,
                Document.deleted_at.is_(None), version_ok, DocumentVersion.id == DocumentChunk.version_id)


def lexical_search(db: DbSession, matter_ids, query: str, n: int = CANDIDATES, as_of: date | None = None
                   ) -> list[tuple[DocumentChunk, Document, int]]:
    ids = matter_ids if isinstance(matter_ids, list) else [matter_ids]
    expr = _or_query(query)
    if not expr:
        return []
    q_en = func.to_tsquery("english", expr)
    q_si = func.to_tsquery("simple", expr)
    rank = func.greatest(func.ts_rank_cd(DocumentChunk.fts, q_en), func.ts_rank_cd(DocumentChunk.fts_simple, q_si))
    rows = db.execute(
        select(DocumentChunk, Document, DocumentVersion.version_number)
        .where(_scope(ids, as_of), or_(DocumentChunk.fts.op("@@")(q_en), DocumentChunk.fts_simple.op("@@")(q_si)))
        .order_by(rank.desc()).limit(n)).all()
    return [(c, d, v) for c, d, v in rows]


def semantic_search(db: DbSession, matter_ids, vector: list[float], model_id: str, n: int = CANDIDATES,
                    as_of: date | None = None):
    ids = matter_ids if isinstance(matter_ids, list) else [matter_ids]
    dist = ChunkEmbedding.embedding.cosine_distance(vector)
    rows = db.execute(
        select(DocumentChunk, Document, DocumentVersion.version_number)
        .join(ChunkEmbedding, ChunkEmbedding.chunk_id == DocumentChunk.id)
        .where(_scope(ids, as_of), ChunkEmbedding.model == model_id)
        .order_by(dist).limit(n)).all()
    return [(c, d, v) for c, d, v in rows]


def unembedded_count(db: DbSession, matter_ids, model_id: str, as_of: date | None = None) -> int:
    ids = matter_ids if isinstance(matter_ids, list) else [matter_ids]
    return db.scalar(
        select(func.count()).select_from(DocumentChunk).join(Document, Document.id == DocumentChunk.document_id)
        .join(DocumentVersion, DocumentVersion.id == DocumentChunk.version_id)
        .where(_scope(ids, as_of),
               ~select(literal(1)).where(ChunkEmbedding.chunk_id == DocumentChunk.id,
                                         ChunkEmbedding.model == model_id).exists())) or 0


def diversify(hits: list[Hit], k: int, per_doc: int) -> list[Hit]:
    out, seen_hash, per = [], set(), {}
    for h in hits:
        if h.chunk.text_hash in seen_hash or per.get(h.chunk.document_id, 0) >= per_doc:
            continue
        seen_hash.add(h.chunk.text_hash)
        per[h.chunk.document_id] = per.get(h.chunk.document_id, 0) + 1
        out.append(h)
        if len(out) == k:
            break
    return out


async def hybrid_search(db: DbSession, matter: Matter, query: str, settings: Settings, *, k: int = 8,
                        mode: str = "hybrid", variants: list[str] | None = None, provider=None,
                        reranker: Reranker | None = None, jurisdictions: list[str] | None = None,
                        as_of: date | None = None, require_current: bool = False) -> SearchResult:
    queries = [query] + [v for v in (variants or []) if v.strip() and v != query]
    warnings: list[str] = []
    model_id = embedding_model_id(matter, settings)
    res = SearchResult([], warnings, model_id, mode)
    lists: list[tuple[str, list[tuple[DocumentChunk, Document, int]]]] = []
    scope_ids = [matter.id] + [i for i in library_ids(db) if i != matter.id]

    if mode in ("hybrid", "lexical"):
        for q in queries:
            lists.append(("lex", lexical_search(db, scope_ids, q, as_of=as_of)))

    if mode in ("hybrid", "semantic"):
        missing = unembedded_count(db, scope_ids, model_id, as_of)
        if missing:
            warnings.append(f"{missing} passage(s) are not embedded yet for this matter; semantic coverage is partial.")
        try:
            prov = provider or build_embedding_provider(settings, external=(embedding_route(matter, settings) == "external"))
            for q in queries:
                vec = await prov.embed_query(q)
                lists.append(("sem", semantic_search(db, scope_ids, vec, model_id, as_of=as_of)))
            toks = getattr(prov, "tokens_used", 0)
            if prov.external and toks:
                db.add(ProviderUsage(matter_id=matter.id, provider=prov.name, kind="embedding",
                                     model=settings.embedding_model, external=True, prompt_tokens=toks,
                                     cost_usd=toks / 1e6 * settings.embedding_price_per_1m_tokens_usd))
        except (ProviderUnavailable, ProviderError) as e:
            warnings.append(f"Semantic search unavailable ({e}); showing keyword results only.")
            res.mode_used = "lexical"

    # Natural-language questions are best served by the embedding model; questions with digits, section signs or quoted
    # terms (statute numbers, amounts, defined terms) need the exact-match path to keep real weight.
    exact = bool(EXACT.search(query))
    fused: dict = {}
    for kind, rows in lists:
        w = (settings.w_semantic_exact if exact else settings.w_semantic) if kind == "sem" else settings.w_lexical
        for rank, (c, doc, ver) in enumerate(rows, start=1):
            h = fused.setdefault(c.id, Hit(c, doc, ver))
            h.score += w / (settings.rrf_k + rank)
            if kind == "sem":
                h.sem_rank = min(h.sem_rank or rank, rank)
            else:
                h.lex_rank = min(h.lex_rank or rank, rank)
    vers = {v.id: v for v in db.scalars(select(DocumentVersion).where(
        DocumentVersion.id.in_({h.chunk.version_id for h in fused.values()})))} if fused else {}
    for h in fused.values():
        h.authority = assess(h.doc, matter.jurisdiction, as_of, jurisdictions)
        v = vers.get(h.chunk.version_id)
        h.retrieved_at = v.source_retrieved_at if v else None
        h.effective_from = v.effective_from if v else None
        h.ocr_applied = bool(v and v.ocr_applied)
    candidates = list(fused.values())
    if require_current:  # hard filter: only authority in force on the date, never superseded
        candidates = [h for h in candidates if not ({"superseded", "not_in_effect_on_date", "negative_treatment"} & set(h.authority.flags))]
    if jurisdictions:    # hard filter: drop known mismatches; unknown jurisdiction stays, flagged
        candidates = [h for h in candidates if "jurisdiction_mismatch" not in h.authority.flags]
    hits = sorted(candidates, key=lambda h: h.score + authority_weight(h, settings), reverse=True)
    hits = (reranker or NoopReranker()).rerank(query, hits)
    hits = diversify(hits, k, settings.max_chunks_per_document)
    for i, h in enumerate(hits, start=1):
        h.cite_id = f"CITE-{i:03d}"
    res.hits = hits
    return res
