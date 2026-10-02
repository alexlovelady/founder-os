"""Authenticated gateway in front of a LOCAL Ollama (or any OpenAI-compatible local server).

Every request must carry both:
  Authorization: Bearer <GATEWAY_TOKEN>
  X-Timestamp / X-Signature  (HMAC over timestamp, method, path, body hash; 60 s window; replay-protected)
Prompts are never logged; only request IDs, model names and sizes."""
import json
import logging
import time
import uuid
from collections import defaultdict, deque

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic_settings import BaseSettings, SettingsConfigDict

from .signing import verify

log = logging.getLogger("gpu-gateway")

ALLOWED_PARAMS = {"temperature", "top_p", "max_tokens", "stop", "seed", "response_format"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_prefix="GATEWAY_", extra="ignore")
    token: str = ""
    ollama_url: str = "http://127.0.0.1:11434"
    allowed_models: str = ""  # comma separated; empty = deny all
    max_body_bytes: int = 2_000_000
    request_timeout_s: int = 900
    rate_limit_per_min: int = 60
    clock_skew_s: int = 60

    def allowlist(self) -> set[str]:
        return {m.strip() for m in self.allowed_models.split(",") if m.strip()}


def create_app(settings: Settings | None = None) -> FastAPI:
    cfg = settings or Settings()
    if len(cfg.token) < 24:
        raise RuntimeError("GATEWAY_TOKEN must be set to a random secret of at least 24 characters")
    app = FastAPI(title="GPU Gateway", docs_url=None, redoc_url=None, openapi_url=None)
    state = {"active": 0}
    seen_sigs: dict[str, float] = {}
    hits: dict[str, deque] = defaultdict(deque)

    async def authenticate(request: Request) -> bytes:
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer ") or auth[7:] != cfg.token:
            raise HTTPException(401, "Unauthorized")
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > cfg.max_body_bytes:
            raise HTTPException(413, "Body too large")
        body = await request.body()
        if len(body) > cfg.max_body_bytes:
            raise HTTPException(413, "Body too large")
        ts, sig = request.headers.get("x-timestamp", ""), request.headers.get("x-signature", "")
        if not verify(cfg.token, request.method, request.url.path, body, ts, sig, cfg.clock_skew_s):
            raise HTTPException(401, "Bad signature")
        now = time.time()
        for k in [k for k, t in seen_sigs.items() if now - t > cfg.clock_skew_s * 2]:
            del seen_sigs[k]
        if sig in seen_sigs:
            raise HTTPException(401, "Replayed request")
        seen_sigs[sig] = now
        q = hits["all"]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= cfg.rate_limit_per_min:
            raise HTTPException(429, "Rate limit exceeded")
        q.append(now)
        return body

    async def installed_models() -> list[str]:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(cfg.ollama_url + "/api/tags")
            r.raise_for_status()
        names = {m["name"] for m in r.json().get("models", [])}
        return sorted(m for m in cfg.allowlist() if m in names)

    @app.get("/health")
    async def health(request: Request):
        await authenticate(request)
        try:
            models = await installed_models()
            ollama_ok = True
        except httpx.HTTPError:
            models, ollama_ok = [], False
        if not ollama_ok:
            return JSONResponse({"status": "degraded", "ollama": False, "active_jobs": state["active"],
                                 "models": []}, status_code=503)
        return {"status": "ok", "ollama": True, "active_jobs": state["active"], "models": models}

    @app.get("/models")
    async def models(request: Request):
        await authenticate(request)
        try:
            return {"models": await installed_models()}
        except httpx.HTTPError:
            raise HTTPException(503, "Inference backend unavailable")

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        body = await authenticate(request)
        rid = uuid.uuid4().hex[:12]
        try:
            req = json.loads(body)
            model = req["model"]
            messages = req["messages"]
        except (ValueError, KeyError, TypeError):
            raise HTTPException(400, "Invalid request body")
        if not isinstance(messages, list) or not messages:
            raise HTTPException(400, "messages required")
        if model not in cfg.allowlist():
            raise HTTPException(403, "Model not allowed")
        out = {"model": model, "messages": messages, "stream": bool(req.get("stream"))}
        out.update({k: v for k, v in req.items() if k in ALLOWED_PARAMS})
        log.info("req=%s model=%s bytes=%d stream=%s", rid, model, len(body), out["stream"])
        url = cfg.ollama_url + "/v1/chat/completions"
        timeout = httpx.Timeout(cfg.request_timeout_s, connect=5)

        if not out["stream"]:
            state["active"] += 1
            try:
                async with httpx.AsyncClient(timeout=timeout) as c:
                    r = await c.post(url, json=out)
            except httpx.ConnectError:
                raise HTTPException(503, "Inference backend unavailable")
            except httpx.TimeoutException:
                raise HTTPException(504, "Inference timed out")
            finally:
                state["active"] -= 1
            return JSONResponse(r.json() if r.headers.get("content-type", "").startswith("application/json")
                                else {"error": "backend error"}, status_code=r.status_code,
                                headers={"X-Request-Id": rid})

        async def gen():
            state["active"] += 1
            try:
                async with httpx.AsyncClient(timeout=timeout) as c:
                    async with c.stream("POST", url, json=out) as r:
                        async for chunk in r.aiter_raw():
                            yield chunk
            except httpx.HTTPError:
                yield b'data: {"error": "backend unavailable"}\n\n'
            finally:
                state["active"] -= 1

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"X-Request-Id": rid})

    @app.post("/v1/embeddings")
    async def embeddings(request: Request):
        body = await authenticate(request)
        try:
            req = json.loads(body)
            model, inp = req["model"], req["input"]
        except (ValueError, KeyError, TypeError):
            raise HTTPException(400, "Invalid request body")
        if model not in cfg.allowlist():
            raise HTTPException(403, "Model not allowed")
        if isinstance(inp, str):
            inp = [inp]
        if not isinstance(inp, list) or not inp or not all(isinstance(x, str) for x in inp):
            raise HTTPException(400, "input must be a non-empty list of strings")
        log.info("req=%s embeddings model=%s items=%d", uuid.uuid4().hex[:12], model, len(inp))
        state["active"] += 1
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(cfg.request_timeout_s, connect=5)) as c:
                r = await c.post(cfg.ollama_url + "/v1/embeddings", json={"model": model, "input": inp})
        except httpx.ConnectError:
            raise HTTPException(503, "Inference backend unavailable")
        except httpx.TimeoutException:
            raise HTTPException(504, "Inference timed out")
        finally:
            state["active"] -= 1
        return JSONResponse(r.json() if r.headers.get("content-type", "").startswith("application/json")
                            else {"error": "backend error"}, status_code=r.status_code)

    return app
