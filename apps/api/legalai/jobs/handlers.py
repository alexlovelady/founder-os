"""Job handlers. Each is `async def handler(job, provider, settings) -> dict`.
Phase 2: llm_complete (generic inference through the provider router) and ingest_document (integrity check).
Parsing/chunking/embedding handlers arrive in Phase 3."""
import uuid

from ..config import Settings
from ..corpus.refresh import refresh_source
from ..ingestion.pipeline import embed_version, ingest_version, ocr_version
from ..models import Job
from ..drafting.pipeline import run_draft, run_redline_generation
from ..research.pipeline import run_research
from ..review.pipeline import run_review
from ..review.summary import run_compare_summary
from ..providers.base import LLMProvider
from .queue import AUTO_ROLE


def resolve_role(payload: dict) -> str:
    role = payload.get("role", "auto")
    if role == "auto":
        return AUTO_ROLE.get(payload.get("task", ""), "deep")
    return role


def model_for(job: Job, provider: LLMProvider, settings: Settings) -> str:
    # The external fallback has its own model name; roles map to local model names only.
    if provider.external and settings.llm_fallback_model:
        return settings.llm_fallback_model
    return settings.model_for_role(resolve_role(job.payload))


async def llm_complete(job: Job, provider: LLMProvider, settings: Settings) -> dict:
    p = job.payload
    model = model_for(job, provider, settings)
    res = await provider.chat(p["messages"], model, **(p.get("params") or {}))
    job.model_used = res.model
    return {"content": res.content, "model": res.model, "prompt_tokens": res.prompt_tokens,
            "completion_tokens": res.completion_tokens}


async def ingest_document(job: Job, provider, settings: Settings) -> dict:
    return ingest_version(uuid.UUID(job.payload["version_id"]), settings)


async def ocr_document(job: Job, provider, settings: Settings) -> dict:
    return await ocr_version(uuid.UUID(job.payload["version_id"]), settings)


async def embed_document(job: Job, provider, settings: Settings) -> dict:
    return await embed_version(uuid.UUID(job.payload["version_id"]), settings, route_override=job.payload.get("route"))


async def research(job: Job, provider: LLMProvider, settings: Settings) -> dict:
    return await run_research(uuid.UUID(job.payload["run_id"]), provider, settings)


async def corpus_refresh(job: Job, provider, settings: Settings) -> dict:
    return await refresh_source(uuid.UUID(job.payload["source_id"]), settings)


async def contract_review(job: Job, provider: LLMProvider, settings: Settings) -> dict:
    return await run_review(uuid.UUID(job.payload["review_id"]), provider, settings)


async def draft(job: Job, provider: LLMProvider, settings: Settings) -> dict:
    return await run_draft(uuid.UUID(job.payload["draft_id"]), provider, settings)


async def redline_generation(job: Job, provider: LLMProvider, settings: Settings) -> dict:
    return await run_redline_generation(uuid.UUID(job.payload["redline_id"]), provider, settings)


async def compare_summary(job: Job, provider: LLMProvider, settings: Settings) -> dict:
    return await run_compare_summary(uuid.UUID(job.payload["comparison_id"]), provider, settings)


HANDLERS = {"ocr_document": ocr_document, "corpus_refresh": corpus_refresh, "contract_review": contract_review, "draft": draft, "redline_generation": redline_generation,
            "compare_summary": compare_summary, "research": research, "llm_complete": llm_complete, "ingest_document": ingest_document, "embed_document": embed_document}
