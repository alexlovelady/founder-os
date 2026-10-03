from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import AsyncIterator


class ProviderUnavailable(Exception):
    """Provider cannot be reached right now (job should wait/retry, not fail)."""


class ProviderError(Exception):
    """Provider reachable but the request failed (bad request, model error)."""


@dataclass
class ChatResult:
    content: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    raw: dict = field(default_factory=dict)


class LLMProvider(ABC):
    name: str = "base"
    external: bool = False

    @abstractmethod
    async def chat(self, messages: list[dict], model: str, **params) -> ChatResult: ...

    @abstractmethod
    def stream(self, messages: list[dict], model: str, **params) -> AsyncIterator[str]: ...

    @abstractmethod
    async def health(self) -> dict: ...

    @abstractmethod
    async def list_models(self) -> list[str]: ...


class EmbeddingProvider(ABC):
    name: str = "base"
    external: bool = False

    @abstractmethod
    async def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    @abstractmethod
    async def embed_query(self, text: str) -> list[float]: ...


class VectorStore(ABC):
    @abstractmethod
    async def upsert(self, items: list[dict]) -> None: ...

    @abstractmethod
    async def semantic_search(self, vector: list[float], k: int, filters: dict) -> list[dict]: ...

    @abstractmethod
    async def delete_document(self, document_id: str) -> None: ...
