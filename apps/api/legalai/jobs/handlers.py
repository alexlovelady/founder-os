"""Job handlers. Each is `async def handler(job, provider, settings) -> dict`.
Phase 2: llm_complete (generic inference through the provider router) and ingest_document (integrity check).
Parsing/chunking/embedding handlers arrive in Phase 3."""
import uuid

from ..config import Settings
from ..db import session_scope
from ..models import DocumentVersion, Job
from ..providers.base import LLMProvider
from ..storage import get_storage, sha256_hex
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
    vid = uuid.UUID(job.payload["version_id"])
    with session_scope() as db:
        v = db.get(DocumentVersion, vid)
        data = get_storage().get(v.storage_key)
        ok = sha256_hex(data) == v.sha256
        v.status = "verified" if ok else "rejected"
    if not ok:
        raise RuntimeError("Stored file hash does not match recorded SHA-256")
    return {"sha256_verified": True, "note": "parsing/chunking/embedding added in Phase 3"}


HANDLERS = {"llm_complete": llm_complete, "ingest_document": ingest_document}
