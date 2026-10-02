"""Job handlers. Each is `async def handler(job, provider, settings) -> dict`.
Phase 2: llm_complete (generic inference through the provider router) and ingest_document (integrity check).
Parsing/chunking/embedding handlers arrive in Phase 3."""
import uuid

from ..config import Settings
from ..ingestion.pipeline import embed_version, ingest_version
from ..models import Job
from ..research.pipeline import run_research
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


async def embed_document(job: Job, provider, settings: Settings) -> dict:
    return await embed_version(uuid.UUID(job.payload["version_id"]), settings)


async def research(job: Job, provider: LLMProvider, settings: Settings) -> dict:
    return await run_research(uuid.UUID(job.payload["run_id"]), provider, settings)


HANDLERS = {"research": research, "llm_complete": llm_complete, "ingest_document": ingest_document, "embed_document": embed_document}
