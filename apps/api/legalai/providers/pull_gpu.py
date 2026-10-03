"""Pull-mode access to the private GPU. The API never connects to your home network: it queues a request row, and the
home node (an outbound HTTPS client) claims it, runs it on local Ollama and posts the answer back. No inbound port,
tunnel, or public hostname is needed on the home side."""
import asyncio
import time
import uuid
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator

from sqlalchemy import delete

from ..config import Settings
from ..db import session_scope
from ..models import GpuNode, GpuRequest
from .base import ChatResult, EmbeddingProvider, LLMProvider, ProviderError, ProviderUnavailable
from .openai_compat import _clean

POLL_S = 0.4


def node_fresh(settings: Settings) -> GpuNode | None:
    with session_scope() as db:
        n = db.get(GpuNode, settings.gpu_node_id)
        if n and n.status == "online" and n.last_heartbeat_at and \
                (datetime.now(timezone.utc) - n.last_heartbeat_at).total_seconds() < settings.gpu_heartbeat_stale_s:
            return n
    return None


async def submit_request(settings: Settings, kind: str, payload: dict) -> dict:
    if not node_fresh(settings):
        raise ProviderUnavailable("Private GPU node is offline")
    with session_scope() as db:
        req = GpuRequest(kind=kind, payload=payload)
        db.add(req)
        db.flush()
        rid = req.id
    t0 = time.monotonic()
    try:
        while True:
            await asyncio.sleep(POLL_S)
            with session_scope() as db:
                r = db.get(GpuRequest, rid)
                status, result, err = r.status, r.result, r.error
                if status in ("done", "failed"):
                    db.delete(r)  # prompts and answers do not stay in the database
            if status == "done":
                return result or {}
            if status == "failed":
                raise ProviderError(err or "GPU node reported an error")
            waited = time.monotonic() - t0
            if status == "pending" and waited > settings.gpu_claim_timeout_s:
                raise ProviderUnavailable("GPU node did not pick up the request")
            if waited > settings.gpu_request_timeout_s:
                raise ProviderUnavailable("GPU request timed out")
    finally:
        with session_scope() as db:  # abandoned/timed-out/cancelled requests are removed, never left queued
            db.execute(delete(GpuRequest).where(GpuRequest.id == rid))


class PulledGpuProvider(LLMProvider):
    name = "local_gpu"
    external = False

    def __init__(self, settings: Settings):
        self.s = settings

    async def chat(self, messages: list[dict], model: str, **params) -> ChatResult:
        d = await submit_request(self.s, "chat", {"model": model, "messages": messages, "params": _clean(params)})
        try:
            usage = d.get("usage") or {}
            return ChatResult(d["choices"][0]["message"]["content"] or "", d.get("model", model), usage.get("prompt_tokens", 0),
                              usage.get("completion_tokens", 0), d)
        except (KeyError, IndexError, TypeError) as e:
            raise ProviderError("Malformed response from GPU node") from e

    async def stream(self, messages, model, **params) -> AsyncIterator[str]:  # pull mode returns whole answers
        r = await self.chat(messages, model, **params)
        yield r.content

    async def health(self) -> dict:
        n = node_fresh(self.s)
        if not n:
            raise ProviderUnavailable("Private GPU node is offline")
        return {"status": "ok", "models": n.models}

    async def list_models(self) -> list[str]:
        n = node_fresh(self.s)
        return list(n.models) if n else []


class PulledEmbeddingProvider(EmbeddingProvider):
    name = "local_gpu"
    external = False

    def __init__(self, settings: Settings, model: str, batch_size: int = 16):
        self.s, self.model, self.batch = settings, model, batch_size
        self.model_id = f"local:{model}"
        self.tokens_used = 0

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        from ..models import EMBEDDING_DIM
        d = await submit_request(self.s, "embeddings", {"model": self.model, "input": texts})
        try:
            vecs = [x["embedding"] for x in sorted(d["data"], key=lambda x: x["index"])]
        except (KeyError, TypeError) as e:
            raise ProviderError("Malformed embedding response from GPU node") from e
        if vecs and len(vecs[0]) != EMBEDDING_DIM:
            raise ProviderError(f"Local embedding model returned {len(vecs[0])} dims; {EMBEDDING_DIM} required")
        return vecs

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), self.batch):
            out += await self._embed(texts[i:i + self.batch])
        return out

    async def embed_query(self, text: str) -> list[float]:
        return (await self._embed([text]))[0]


def purge_stale_requests(settings: Settings) -> int:
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=settings.gpu_request_timeout_s + 120)
    with session_scope() as db:
        return db.execute(delete(GpuRequest).where(GpuRequest.created_at < cutoff)).rowcount or 0
