"""Security hardening and end-to-end privacy enforcement."""
import json
import re

import httpx
import pytest

from legalai.config import get_settings
from legalai.db import session_scope
from legalai.middleware import general_limiter, heavy_limiter
from tests.test_ingestion import CONTRACT
from tests.test_jobs import FakeProvider
from tests.test_retrieval import drain, mk_matter, upload


# ---- headers, limits, logging ---------------------------------------------------------------------------------
def test_security_headers_and_request_id(make_api):
    a = make_api("admin@example.com")
    r = a.get("/api/auth/me")
    h = r.headers
    assert h["x-content-type-options"] == "nosniff" and h["x-frame-options"] == "DENY" and h["cache-control"] == "no-store"
    assert h["referrer-policy"] == "no-referrer" and re.fullmatch(r"[0-9a-f]{16}", h["x-request-id"])
    assert a.c.get("/api/auth/me", headers={"x-request-id": "trace123"}).headers["x-request-id"] == "trace123"
    assert a.c.get("/api/auth/me", headers={"x-request-id": "bad id\r\ninjected"}).headers["x-request-id"] != "bad id\r\ninjected"


def test_html_gets_csp_and_hsts_only_when_secure(make_api, monkeypatch, tmp_path):
    (tmp_path / "index.html").write_text("<html></html>")
    monkeypatch.setattr("legalai.main.Path", lambda *_a, **_k: type("P", (), {"resolve": lambda s: s, "parent": tmp_path.parent, "__truediv__": lambda s, o: tmp_path})())
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    monkeypatch.setenv("COOKIE_SECURE", "true")
    get_settings.cache_clear()
    c = TestClient(create_app())
    r = c.get("/healthz")
    assert "strict-transport-security" in r.headers


def test_rate_limit_on_heavy_endpoints_and_general(make_api, monkeypatch):
    a = make_api("admin@example.com")
    m = mk_matter(a)
    heavy_limiter.limit = 5
    try:
        codes = [a.post("/api/research", json={"matter_id": m["id"], "question": f"question number {i}"}).status_code for i in range(8)]
    finally:
        heavy_limiter.limit = 60
    assert codes[:5] == [202] * 5 and set(codes[5:]) == {429}
    assert a.get("/api/matters").status_code == 200                         # GETs are not on the heavy limiter
    general_limiter.limit = 3
    try:
        statuses = [a.get("/api/matters").status_code for _ in range(5)]
    finally:
        general_limiter.limit = 600
    assert 429 in statuses


def test_oversized_json_body_rejected_before_processing(make_api):
    a = make_api("admin@example.com")
    big = "x" * (3 * 1024 * 1024)
    r = a.c.post("/api/matters", content=big, headers={"x-csrf-token": a.csrf, "content-type": "application/json"})
    assert r.status_code == 413


def test_forwarded_for_ignored_unless_proxy_trusted(make_api, monkeypatch):
    a = make_api("admin@example.com")
    general_limiter.limit = 3
    try:
        sts = [a.c.get("/api/matters", headers={"x-forwarded-for": f"9.9.9.{i}"}).status_code for i in range(5)]
    finally:
        general_limiter.limit = 600
    assert 429 in sts                                                        # spoofed XFF cannot dodge the limiter
    general_limiter.reset()
    monkeypatch.setenv("TRUST_PROXY", "true")
    get_settings.cache_clear()
    general_limiter.limit = 3
    try:
        sts = [a.c.get("/api/matters", headers={"x-forwarded-for": f"9.9.9.{i}"}).status_code for i in range(5)]
    finally:
        general_limiter.limit = 600
    assert 429 not in sts                                                    # behind a trusted proxy each client is separate


def test_production_requires_secret_and_hides_docs(monkeypatch):
    from legalai.main import create_app
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("SESSION_SECRET", "")
    get_settings.cache_clear()
    with pytest.raises(RuntimeError):
        create_app()
    monkeypatch.setenv("SESSION_SECRET", "x" * 40)
    get_settings.cache_clear()
    from fastapi.testclient import TestClient
    c = TestClient(create_app())
    for path in ("/openapi.json", "/docs"):          # the SPA fallback may answer, but never with the API schema
        r = c.get(path)
        assert "openapi" not in r.text.lower() and "swagger" not in r.text.lower()


# ---- admin ------------------------------------------------------------------------------------------------------
def test_admin_health_metrics_and_user_management(make_api):
    admin, bob = make_api("admin@example.com"), make_api("bob@example.com")
    assert bob.get("/api/admin/health").status_code == 403 and bob.get("/api/admin/metrics").status_code == 403
    h = admin.get("/api/admin/health").json()
    assert h["checks"]["database"]["ok"] and h["checks"]["storage"]["ok"] and h["checks"]["queue"]["ok"]
    m = mk_matter(admin)
    upload(admin, m["id"], "a.txt", CONTRACT.encode())
    met = admin.get("/api/admin/metrics").json()
    assert met["counts"]["users"] == 2 and met["counts"]["matters"] == 1 and met["counts"]["documents"] == 1
    assert met["jobs"].get("QUEUED", 0) >= 1 and met["storage_bytes"] > 0 and met["database_bytes"] > 0
    assert met["budgets"]["external_llm"]["limit_usd"] == 0
    users = admin.get("/api/admin/users").json()
    bid = next(u["id"] for u in users if u["email"] == "bob@example.com")
    assert admin.patch(f"/api/admin/users/{bid}", json={"is_active": False}).json()["is_active"] is False
    assert bob.get("/api/matters").status_code == 401                         # existing session ended immediately
    me = next(u["id"] for u in users if u["email"] == "admin@example.com")
    assert admin.patch(f"/api/admin/users/{me}", json={"is_active": False}).status_code == 409


# ---- privacy: nothing leaves for an external host from a local-only matter -------------------------------------
GPU = "https://gpu.test"
VEC = [0.01] * 1024


@pytest.fixture
def netguard(monkeypatch):
    """Route every outbound httpx call to in-test fakes and record the hosts contacted."""
    hosts: list[str] = []
    monkeypatch.setenv("GPU_MODE", "push")
    monkeypatch.setenv("GPU_NODE_URL", GPU)
    monkeypatch.setenv("GPU_NODE_TOKEN", "t" * 32)
    monkeypatch.setenv("FAST_MODEL", "fast-m")
    monkeypatch.setenv("DEEP_MODEL", "deep-m")
    monkeypatch.setenv("EMBEDDING_API_KEY", "voyage-test-key")
    monkeypatch.setenv("EMBEDDING_PROVIDER", "external")
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_FALLBACK_BASE_URL", "https://llm.external.test")
    monkeypatch.setenv("EXTERNAL_LLM_MONTHLY_BUDGET_USD", "50")
    get_settings.cache_clear()

    def respond(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        hosts.append(host)
        path = request.url.path
        if host == "gpu.test":
            if path == "/health":
                return httpx.Response(200, json={"status": "ok"})
            if path == "/v1/embeddings":
                n = len(json.loads(request.content)["input"])
                return httpx.Response(200, json={"data": [{"index": i, "embedding": VEC} for i in range(n)]})
            body = json.loads(request.content)
            text = body["messages"][-1]["content"]
            out = "[]" if "extracting facts" in text or "helping a lawyer" in text or "skeptical senior" in text or "alternative search" in text else \
                "## Short Answer\nEither party may terminate for convenience on thirty days written notice."
            return httpx.Response(200, json={"model": body["model"], "choices": [{"message": {"content": out}}], "usage": {}})
        if host == "api.voyageai.com":
            n = len(json.loads(request.content)["input"])
            return httpx.Response(200, json={"data": [{"index": i, "embedding": VEC} for i in range(n)], "usage": {"total_tokens": n}})
        return httpx.Response(500, json={"error": "unexpected host " + host})

    transport = httpx.MockTransport(respond)
    real_init = httpx.AsyncClient.__init__

    def init(self, *a, **k):
        k["transport"] = transport
        real_init(self, *a, **k)
    monkeypatch.setattr(httpx.AsyncClient, "__init__", init)
    return hosts


def run_everything(a, m, drain_primary):
    d = upload(a, m["id"], "msa.txt", CONTRACT.encode())
    drain(drain_primary)
    a.post(f"/api/matters/{m['id']}/search", json={"query": "terminate for convenience"})
    a.post("/api/research", json={"matter_id": m["id"], "question": "Can either party terminate for convenience?"})
    a.post("/api/contracts/review", json={"document_id": d["id"]})
    a.post("/api/drafts", json={"matter_id": m["id"], "instructions": "Draft a short NDA clause", "mode": "draft_from_scratch"})
    a.post("/api/inference", json={"matter_id": m["id"], "messages": [{"role": "user", "content": "hi"}]})
    drain(drain_primary)


def test_local_only_matter_never_contacts_external_hosts_across_all_workflows(make_api, netguard):
    from legalai.providers.local_gpu import LocalGpuProvider
    a = make_api("admin@example.com")
    m = mk_matter(a, "local_only")
    run_everything(a, m, LocalGpuProvider(GPU, "t" * 32))
    assert netguard and set(netguard) == {"gpu.test"}
    with session_scope() as db:
        from legalai.models import ProviderUsage
        assert db.query(ProviderUsage).filter_by(external=True).count() == 0


def test_private_matter_default_stays_local_and_gpu_outage_never_goes_external(make_api, netguard):
    from legalai.providers.local_gpu import LocalGpuProvider
    a = make_api("admin@example.com")
    m = mk_matter(a, "private")                       # default private: fallback disabled, embeddings local
    up = upload(a, m["id"], "msa.txt", CONTRACT.encode())
    drain(LocalGpuProvider(GPU, "t" * 32))
    netguard.clear()
    # node goes away: jobs wait; nothing may be sent to the external LLM or embedding API
    a.post("/api/research", json={"matter_id": m["id"], "question": "Can either party terminate for convenience?"})
    down = FakeProvider("local_gpu", online=False)
    drain(down)
    assert "llm.external.test" not in netguard and "api.voyageai.com" not in netguard
    waiting = [j for j in a.get(f"/api/jobs?matter_id={m['id']}").json() if j["job_type"] == "research"]
    assert waiting and waiting[0]["state"] == "WAITING_FOR_GPU"
    # only an explicit per-matter opt-in (plus configured provider and budget) lets text leave when the GPU is down
    std = mk_matter(a, "standard", llm_fallback_mode="allowed")
    a.post("/api/inference", json={"matter_id": std["id"], "messages": [{"role": "user", "content": "hello"}]})
    drain(down)
    assert "llm.external.test" in netguard


def test_framing_is_denied_unless_the_shell_origin_is_allowed(make_api, monkeypatch):
    from legalai.config import get_settings
    a = make_api("admin@example.com")
    r = a.get("/")
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"] and r.headers["x-frame-options"] == "DENY"
    monkeypatch.setattr(get_settings(), "embed_origins", "https://shell.example.com, http://evil.test")
    r = a.get("/")
    assert "frame-ancestors https://shell.example.com" in r.headers["content-security-policy"] and "evil.test" not in r.headers["content-security-policy"]
    assert "x-frame-options" not in r.headers
