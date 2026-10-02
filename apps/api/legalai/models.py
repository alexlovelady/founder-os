import enum
import uuid
from datetime import datetime, date
from sqlalchemy import (String, Text, Boolean, Integer, BigInteger, Float, Date, DateTime, ForeignKey,
                        UniqueConstraint, Index, func)
from pgvector.sqlalchemy import Vector
from sqlalchemy import Computed
from sqlalchemy.dialects.postgresql import UUID, JSONB, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base


def _uuid():
    return uuid.uuid4()


class PrivacyMode(str, enum.Enum):
    standard = "standard"
    private = "private"
    local_only = "local_only"


class FallbackMode(str, enum.Enum):
    disabled = "disabled"
    ask = "ask"
    allowed = "allowed"


class JobState(str, enum.Enum):
    NEW = "NEW"
    QUEUED = "QUEUED"
    WAITING_FOR_GPU = "WAITING_FOR_GPU"
    RUNNING = "RUNNING"
    VALIDATING = "VALIDATING"
    COMPLETE = "COMPLETE"
    RETRYABLE = "RETRYABLE"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class User(Base, TimestampMixin):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(200), default="")
    role: Mapped[str] = mapped_column(String(20), default="user")  # user | admin
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Matter(Base, TimestampMixin):
    __tablename__ = "matters"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(300))
    description: Mapped[str] = mapped_column(Text, default="")
    jurisdiction: Mapped[str] = mapped_column(String(100), default="")
    relevant_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(30), default="open")
    privacy_mode: Mapped[str] = mapped_column(String(20), default=PrivacyMode.private.value)
    # Private mode: external embeddings only if the user explicitly enables them.
    external_embedding_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    llm_fallback_mode: Mapped[str] = mapped_column(String(20), default=FallbackMode.disabled.value)
    kind: Mapped[str] = mapped_column(String(20), default="matter")  # matter | library (shared public authorities)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MatterMember(Base):
    __tablename__ = "matter_members"
    __table_args__ = (UniqueConstraint("matter_id", "user_id"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(20))  # owner | editor | viewer


class Document(Base, TimestampMixin):
    __tablename__ = "documents"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(500))
    doc_type: Mapped[str] = mapped_column(String(50), default="user_document")
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # Authority metadata (spec section 12). 'detected' values are heuristic suggestions; user edits win.
    authority_type: Mapped[str] = mapped_column(String(40), default="user_document")
    jurisdiction: Mapped[str] = mapped_column(String(100), default="")
    court: Mapped[str] = mapped_column(String(200), default="")
    court_level: Mapped[str] = mapped_column(String(30), default="")  # supreme | appellate | trial | agency
    citation_text: Mapped[str] = mapped_column(String(300), default="")
    document_date: Mapped[date | None] = mapped_column(Date)
    effective_from: Mapped[date | None] = mapped_column(Date)
    effective_to: Mapped[date | None] = mapped_column(Date)
    precedential_status: Mapped[str] = mapped_column(String(30), default="")
    source_url: Mapped[str] = mapped_column(String(1000), default="")
    official_source: Mapped[bool] = mapped_column(Boolean, default=False)
    superseded: Mapped[bool] = mapped_column(Boolean, default=False)
    metadata_source: Mapped[str] = mapped_column(String(20), default="detected")  # detected | user
    treatment: Mapped[list] = mapped_column(JSONB, default=list)  # [{type, citing, note, date, source}]
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentVersion(Base):
    __tablename__ = "document_versions"
    __table_args__ = (UniqueConstraint("document_id", "version_number"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    version_number: Mapped[int] = mapped_column(Integer)
    original_filename: Mapped[str] = mapped_column(String(300))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    storage_key: Mapped[str] = mapped_column(String(600))
    status: Mapped[str] = mapped_column(String(30), default="uploaded")  # uploaded | verified | rejected
    effective_from: Mapped[date | None] = mapped_column(Date)  # library versions: when this text took effect
    effective_to: Mapped[date | None] = mapped_column(Date)
    source_retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    parse_status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|parsed|needs_ocr|failed
    parse_error: Mapped[str | None] = mapped_column(Text)
    extracted_text: Mapped[str | None] = mapped_column(Text)
    page_count: Mapped[int | None] = mapped_column(Integer)
    embed_status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|embedded|waiting|failed
    embedding_model: Mapped[str | None] = mapped_column(String(200))
    uploaded_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Job(Base, TimestampMixin):
    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_runnable", "state", "next_attempt_at"),)
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    job_type: Mapped[str] = mapped_column(String(60))
    state: Mapped[str] = mapped_column(String(30), default=JobState.NEW.value)
    requires_gpu: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    result: Mapped[dict | None] = mapped_column(JSONB)
    status_message: Mapped[str] = mapped_column(Text, default="")
    error: Mapped[str | None] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    next_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    needs_fallback_approval: Mapped[bool] = mapped_column(Boolean, default=False)
    fallback_approved: Mapped[bool] = mapped_column(Boolean, default=False)
    provider_used: Mapped[str | None] = mapped_column(String(60))
    model_used: Mapped[str | None] = mapped_column(String(200))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class GpuNode(Base):
    __tablename__ = "gpu_nodes"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    status: Mapped[str] = mapped_column(String(20), default="offline")
    gpu_name: Mapped[str] = mapped_column(String(200), default="")
    vram_total_mb: Mapped[int | None] = mapped_column(Integer)
    vram_free_mb: Mapped[int | None] = mapped_column(Integer)
    models: Mapped[list] = mapped_column(JSONB, default=list)
    active_jobs: Mapped[int] = mapped_column(Integer, default=0)
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ProviderUsage(Base):
    __tablename__ = "provider_usage"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"))
    matter_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    provider: Mapped[str] = mapped_column(String(60))
    kind: Mapped[str] = mapped_column(String(30))  # llm | embedding
    model: Mapped[str] = mapped_column(String(200))
    external: Mapped[bool] = mapped_column(Boolean, default=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    matter_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), index=True)
    action: Mapped[str] = mapped_column(String(100))
    object_type: Mapped[str] = mapped_column(String(50), default="")
    object_id: Mapped[str] = mapped_column(String(100), default="")
    detail: Mapped[dict] = mapped_column(JSONB, default=dict)


EMBEDDING_DIM = 1024


class DocumentChunk(Base):
    """A citable passage. Invariant: version.extracted_text[char_start:char_end] == text."""
    __tablename__ = "document_chunks"
    __table_args__ = (UniqueConstraint("version_id", "chunk_index"),
                      Index("ix_chunks_fts", "fts", postgresql_using="gin"),
                      Index("ix_chunks_fts_simple", "fts_simple", postgresql_using="gin"))
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("document_versions.id", ondelete="CASCADE"), index=True)
    chunk_index: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    text_hash: Mapped[str] = mapped_column(String(64), index=True)
    page: Mapped[int | None] = mapped_column(Integer)
    page_end: Mapped[int | None] = mapped_column(Integer)
    heading_path: Mapped[list] = mapped_column(JSONB, default=list)
    section_number: Mapped[str] = mapped_column(String(100), default="")
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    fts = mapped_column(TSVECTOR, Computed("to_tsvector('english', text)", persisted=True))
    fts_simple = mapped_column(TSVECTOR, Computed("to_tsvector('simple', text)", persisted=True))


class ChunkEmbedding(Base):
    """One vector per (chunk, embedding model). Vectors from different models are never compared."""
    __tablename__ = "chunk_embeddings"
    __table_args__ = (Index("ix_chunk_emb_hnsw", "embedding", postgresql_using="hnsw",
                            postgresql_ops={"embedding": "vector_cosine_ops"}),
                      Index("ix_chunk_emb_cache", "text_hash", "model"))
    chunk_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("document_chunks.id", ondelete="CASCADE"), primary_key=True)
    model: Mapped[str] = mapped_column(String(200), primary_key=True)
    text_hash: Mapped[str] = mapped_column(String(64))
    embedding = mapped_column(Vector(EMBEDDING_DIM))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ResearchRun(Base):
    """Auditable record of one research answer (spec section 24)."""
    __tablename__ = "research_runs"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    question: Mapped[str] = mapped_column(Text)
    jurisdiction: Mapped[str] = mapped_column(String(100), default="")
    as_of: Mapped[date | None] = mapped_column(Date)
    depth: Mapped[str] = mapped_column(String(10), default="auto")
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued | complete | failed
    privacy_mode: Mapped[str] = mapped_column(String(20), default="")
    provider: Mapped[str | None] = mapped_column(String(60))
    model: Mapped[str | None] = mapped_column(String(200))
    prompt_version: Mapped[str] = mapped_column(String(40), default="")
    answer: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSONB)
    retrieval: Mapped[dict | None] = mapped_column(JSONB)
    validation: Mapped[dict | None] = mapped_column(JSONB)
    output_hash: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Playbook(Base, TimestampMixin):
    """A reviewer's standard positions. Differences from a playbook are flagged for judgment, never called bad."""
    __tablename__ = "playbooks"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    perspective: Mapped[str] = mapped_column(String(30), default="neutral")  # neutral | customer | vendor | employer | employee
    rules: Mapped[list] = mapped_column(JSONB, default=list)  # [{topic, preferred, fallback, red_flags, severity}]


class ContractReview(Base):
    __tablename__ = "contract_reviews"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    version_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("document_versions.id", ondelete="CASCADE"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    playbook_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    perspective: Mapped[str] = mapped_column(String(30), default="neutral")
    status: Mapped[str] = mapped_column(String(20), default="queued")
    provider: Mapped[str | None] = mapped_column(String(60))
    model: Mapped[str | None] = mapped_column(String(200))
    prompt_version: Mapped[str] = mapped_column(String(40), default="")
    result: Mapped[dict | None] = mapped_column(JSONB)
    output_hash: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Obligation(Base, TimestampMixin):
    __tablename__ = "obligations"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    review_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    party: Mapped[str] = mapped_column(String(300), default="")
    obligation: Mapped[str] = mapped_column(Text)
    trigger: Mapped[str] = mapped_column(Text, default="")
    deadline_text: Mapped[str] = mapped_column(String(300), default="")
    deadline_date: Mapped[date | None] = mapped_column(Date)
    recurrence: Mapped[str] = mapped_column(String(200), default="")
    source_chunk_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    source_clause: Mapped[str] = mapped_column(String(300), default="")
    confidence: Mapped[str] = mapped_column(String(10), default="medium")  # low | medium | high
    status: Mapped[str] = mapped_column(String(20), default="open")  # open | done | dismissed


class Draft(Base, TimestampMixin):
    __tablename__ = "drafts"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"), index=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    mode: Mapped[str] = mapped_column(String(40))
    doc_type: Mapped[str] = mapped_column(String(100), default="")
    instructions: Mapped[str] = mapped_column(Text)
    inputs: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    content: Mapped[str | None] = mapped_column(Text)
    result: Mapped[dict | None] = mapped_column(JSONB)  # placeholders, assumptions, review notes, unverified specifics
    provider: Mapped[str | None] = mapped_column(String(60))
    model: Mapped[str | None] = mapped_column(String(200))
    prompt_version: Mapped[str] = mapped_column(String(40), default="")
    output_hash: Mapped[str | None] = mapped_column(String(64))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Redline(Base, TimestampMixin):
    __tablename__ = "redlines"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    version_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True))
    review_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    chunk_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    clause_label: Mapped[str] = mapped_column(String(300), default="")
    original: Mapped[str] = mapped_column(Text)  # always the stored source text, never model-supplied
    proposed: Mapped[str | None] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(Text, default="")
    risk: Mapped[str] = mapped_column(String(20), default="medium")
    support: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending | accepted | rejected
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"))
    job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))


class Comparison(Base):
    __tablename__ = "comparisons"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    matter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("matters.id", ondelete="CASCADE"), index=True)
    version_a: Mapped[uuid.UUID] = mapped_column(ForeignKey("document_versions.id", ondelete="CASCADE"))
    version_b: Mapped[uuid.UUID] = mapped_column(ForeignKey("document_versions.id", ondelete="CASCADE"))
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    result: Mapped[dict] = mapped_column(JSONB, default=dict)
    summary: Mapped[str | None] = mapped_column(Text)
    summary_job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CorpusSource(Base, TimestampMixin):
    """A configured official source for the shared authority library (spec sections 28 and 29)."""
    __tablename__ = "corpus_sources"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(300))
    adapter: Mapped[str] = mapped_column(String(40))  # ecfr | url
    config: Mapped[dict] = mapped_column(JSONB, default=dict)
    jurisdiction: Mapped[str] = mapped_column(String(100), default="")
    authority_type: Mapped[str] = mapped_column(String(40), default="regulation")
    refresh_hours: Mapped[int] = mapped_column(Integer, default=24)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    document_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[str] = mapped_column(String(300), default="never run")
    etag: Mapped[str | None] = mapped_column(String(300))
