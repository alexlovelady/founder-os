import json
from typing import AsyncIterator

import httpx

from .base import ChatResult, LLMProvider, ProviderError, ProviderUnavailable

# Parameters we pass through; everything else is dropped.
ALLOWED_PARAMS = {"temperature", "top_p", "max_tokens", "stop", "seed", "response_format"}


def _clean(params: dict) -> dict:
    return {k: v for k, v in params.items() if k in ALLOWED_PARAMS and v is not None}


class OpenAICompatibleProvider(LLMProvider):
    """Generic /v1/chat/completions client. Works for llama.cpp, vLLM, or a managed API.
    `headers_fn(method, path, body) -> dict` lets subclasses add auth/signatures."""

    name = "openai_compatible"

    def __init__(self, base_url: str, api_key: str = "", external: bool = True, timeout_s: float = 600,
                 headers_fn=None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.external = external
        self.timeout = httpx.Timeout(timeout_s, connect=10)
        self.headers_fn = headers_fn

    def _headers(self, method: str, path: str, body: bytes) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        if self.headers_fn:
            h.update(self.headers_fn(method, path, body))
        return h

    async def _request(self, method: str, path: str, payload: dict | None = None, timeout=None) -> httpx.Response:
        body = json.dumps(payload).encode() if payload is not None else b""
        try:
            async with httpx.AsyncClient(timeout=timeout or self.timeout) as c:
                r = await c.request(method, self.base_url + path, content=body or None,
                                    headers=self._headers(method, path, body))
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout, httpx.RemoteProtocolError) as e:
            raise ProviderUnavailable(f"{self.name} unreachable: {type(e).__name__}") from e
        if r.status_code in (502, 503, 504, 530):  # tunnel up but origin down
            raise ProviderUnavailable(f"{self.name} unavailable (HTTP {r.status_code})")
        if r.status_code in (401, 403):
            raise ProviderError(f"{self.name} rejected credentials (HTTP {r.status_code})")
        if r.status_code >= 400:
            raise ProviderError(f"{self.name} error HTTP {r.status_code}: {r.text[:300]}")
        return r

    async def chat(self, messages, model, **params) -> ChatResult:
        r = await self._request("POST", "/v1/chat/completions",
                                {"model": model, "messages": messages, "stream": False, **_clean(params)})
        d = r.json()
        usage = d.get("usage") or {}
        return ChatResult(
            content=d["choices"][0]["message"]["content"] or "",
            model=d.get("model", model),
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            raw=d,
        )

    async def stream(self, messages, model, **params) -> AsyncIterator[str]:
        payload = {"model": model, "messages": messages, "stream": True, **_clean(params)}
        body = json.dumps(payload).encode()
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as c:
                async with c.stream("POST", self.base_url + "/v1/chat/completions", content=body,
                                    headers=self._headers("POST", "/v1/chat/completions", body)) as r:
                    if r.status_code >= 400:
                        raise ProviderError(f"{self.name} error HTTP {r.status_code}")
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            return
                        delta = json.loads(data)["choices"][0].get("delta", {}).get("content")
                        if delta:
                            yield delta
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as e:
            raise ProviderUnavailable(f"{self.name} unreachable") from e

    async def health(self) -> dict:
        r = await self._request("GET", "/health", timeout=httpx.Timeout(10, connect=5))
        return r.json()

    async def list_models(self) -> list[str]:
        r = await self._request("GET", "/models", timeout=httpx.Timeout(10, connect=5))
        d = r.json()
        return [m["id"] if isinstance(m, dict) else m for m in d.get("models", d.get("data", []))]
