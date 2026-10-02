"""Security headers, request IDs and structured access logs, rate limiting, body-size limits.
Logs never contain request bodies, query strings or cookies."""
import json
import logging
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse

from .config import get_settings
from .security import RateLimiter

log = logging.getLogger("legalai.access")

CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'")

general_limiter = RateLimiter(limit=600, window_s=60)
heavy_limiter = RateLimiter(limit=60, window_s=60)      # uploads and anything that queues LLM/GPU work
HEAVY_PREFIXES = ("/api/documents", "/api/research", "/api/inference", "/api/contracts/review", "/api/drafts", "/api/redlines",
                  "/api/comparisons", "/api/library/sources")
SMALL_BODY = 2 * 1024 * 1024


def client_ip(request) -> str:
    if get_settings().trust_proxy:
        xff = request.headers.get("x-forwarded-for", "")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


class HardeningMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        s = get_settings()
        rid = request.headers.get("x-request-id", "")[:64] if request.headers.get("x-request-id", "").isalnum() else uuid.uuid4().hex[:16]
        path = request.url.path
        t0 = time.perf_counter()
        resp = None
        if path.startswith("/api/"):
            ip = client_ip(request)
            try:
                general_limiter.check(f"g:{ip}")
                if request.method != "GET" and path.startswith(HEAVY_PREFIXES):
                    heavy_limiter.check(f"h:{ip}")
            except Exception:  # RateLimiter raises HTTPException(429)
                resp = JSONResponse({"detail": "Too many requests"}, status_code=429, headers={"Retry-After": "30"})
            if resp is None and request.method in ("POST", "PUT", "PATCH"):
                limit = s.max_upload_mb * 1024 * 1024 + 1024 * 1024 if path.startswith("/api/documents") else SMALL_BODY
                cl = request.headers.get("content-length")
                if cl and cl.isdigit() and int(cl) > limit:
                    resp = JSONResponse({"detail": "Request body too large"}, status_code=413)
        if resp is None:
            resp = await call_next(request)
        resp.headers["X-Request-Id"] = rid
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        if not path.startswith("/api/"):
            resp.headers.setdefault("Content-Security-Policy", CSP)
        if path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        if s.cookie_secure:
            resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        if path != "/healthz":
            log.info(json.dumps({"rid": rid, "method": request.method, "path": path, "status": resp.status_code,
                                 "ms": round((time.perf_counter() - t0) * 1000, 1)}))
        return resp
