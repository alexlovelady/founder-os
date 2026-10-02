import asyncio
import json
import random

import httpx

from ..config import Settings
from ..models import EMBEDDING_DIM
from .base import EmbeddingProvider, ProviderError, ProviderUnavailable
from .signing import sign


class EmbeddingResult:
    def __init__(self, vectors: list[list[float]], tokens: int = 0):
        self.vectors, self.tokens = vectors, tokens


class VoyageEmbeddingProvider(EmbeddingProvider):
    """External embedding API. Source text leaves Railway: only use through privacy.assert_external_embedding_allowed."""
    name = "voyage"
    external = True

    def __init__(self, api_key: str, model: str, base_url: str = "https://api.voyageai.com/v1",
                 batch_size: int = 32, max_retries: int = 5, transport: httpx.AsyncBaseTransport | None = None):
        self.key, self.model, self.base = api_key, model, base_url.rstrip("/")
        self.batch, self.max_retries, self.transport = batch_size, max_retries, transport
        self.model_id = f"voyage:{model}"
        self.tokens_used = 0

    async def _embed(self, texts: list[str], input_type: str) -> list[list[float]]:
        body = {"input": texts, "model": self.model, "input_type": input_type}
        for attempt in range(self.max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=60, transport=self.transport) as c:
                    r = await c.post(f"{self.base}/embeddings", json=body,
                                     headers={"Authorization": f"Bearer {self.key}"})
            except (httpx.ConnectError, httpx.TimeoutException) as e:
                if attempt == self.max_retries:
                    raise ProviderUnavailable("Embedding API unreachable") from e
            else:
                if r.status_code == 200:
                    d = r.json()
                    self.tokens_used += (d.get("usage") or {}).get("total_tokens", 0)
                    vecs = [x["embedding"] for x in sorted(d["data"], key=lambda x: x["index"])]
                    if vecs and len(vecs[0]) != EMBEDDING_DIM:
                        raise ProviderError(f"Embedding dimension {len(vecs[0])} != {EMBEDDING_DIM}")
                    return vecs
                if r.status_code in (401, 403):
                    raise ProviderError("Embedding API rejected the API key")
                if r.status_code not in (429, 500, 502, 503, 504) or attempt == self.max_retries:
                    raise ProviderError(f"Embedding API error HTTP {r.status_code}: {r.text[:200]}")
            await asyncio.sleep(min(30, 2 ** attempt) + random.random())
        raise ProviderUnavailable("Embedding API unavailable")

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        out: list[list[float]] = []
        for i in range(0, len(texts), self.batch):
            out += await self._embed(texts[i:i + self.batch], "document")
        return out

    async def embed_query(self, text: str) -> list[float]:
        return (await self._embed([text], "query"))[0]


class LocalEmbeddingProvider(EmbeddingProvider):
    """Embeddings from the private GPU node via the authenticated gateway. Text never leaves your hardware."""
    name = "local_gpu"
    external = False

    def __init__(self, base_url: str, token: str, model: str, batch_size: int = 16, timeout_s: float = 300,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.base, self.token, self.model = base_url.rstrip("/"), token, model
        self.batch, self.timeout, self.transport = batch_size, timeout_s, transport
        self.model_id = f"local:{model}"
        self.tokens_used = 0

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        path = "/v1/embeddings"
        body = json.dumps({"model": self.model, "input": texts}).encode()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout, connect=10), transport=self.transport) as c:
                r = await c.post(self.base + path, content=body, headers={
                    "Content-Type": "application/json", "Authorization": f"Bearer {self.token}",
                    **sign(self.token, "POST", path, body)})
        except (httpx.ConnectError, httpx.TimeoutException, httpx.RemoteProtocolError) as e:
            raise ProviderUnavailable("GPU node unreachable") from e
        if r.status_code in (502, 503, 504, 530):
            raise ProviderUnavailable(f"GPU node unavailable (HTTP {r.status_code})")
        if r.status_code != 200:
            raise ProviderError(f"GPU embedding error HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        vecs = [x["embedding"] for x in sorted(d["data"], key=lambda x: x["index"])]
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


def build_embedding_provider(settings: Settings, external: bool) -> EmbeddingProvider:
    """Caller decides `external` from the matter's privacy policy (see privacy.embedding_route)."""
    if external:
        return VoyageEmbeddingProvider(settings.embedding_api_key, settings.embedding_model,
                                       settings.voyage_base_url, settings.embedding_batch_size)
    return LocalEmbeddingProvider(settings.gpu_node_url, settings.gpu_node_token, settings.local_embedding_model)
