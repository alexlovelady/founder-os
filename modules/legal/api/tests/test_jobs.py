"""Offline queueing and the no-silent-fallback guarantees."""
import asyncio

import pytest

from legalai.config import get_settings
from legalai.db import session_scope
from legalai.jobs.queue import InvalidTransition, transition
from legalai.jobs.runner import process_one
from legalai.models import Job, Matter, ProviderUsage
from legalai.providers.base import ChatResult, LLMProvider, ProviderUnavailable
from legalai.privacy import decide_fallback, effective_fallback_mode, external_embedding_allowed
from legalai.providers.signing import sign, verify


class FakeProvider(LLMProvider):
    def __init__(self, name="fake", external=False, online=True):
        self.name, self.external, self.online = name, external, online
        self.chat_calls = 0
        self.models_seen = []

    async def chat(self, messages, model, **p):
        if not self.online:
            raise ProviderUnavailable("down")
        self.chat_calls += 1
        self.models_seen.append(model)
        return ChatResult("answer", model, 100, 100)

    async def stream(self, *a, **k):  # pragma: no cover
        yield ""

    async def health(self):
        if not self.online:
            raise ProviderUnavailable("down")
        return {"status": "ok"}

    async def list_models(self):
        return []


def submit(a, matter_id, **kw):
    r = a.post("/api/inference", json={"matter_id": matter_id, "messages": [{"role": "user", "content": "hi"}], **kw})
    assert r.status_code == 202, r.text
    return r.json()["id"]


def run(primary, fallback=None):
    return asyncio.run(process_one(get_settings(), primary=primary, fallback=fallback))


def state(a, jid):
    return a.get(f"/api/jobs/{jid}").json()


@pytest.fixture
def setup(make_api):
    a = make_api("admin@example.com")
    return a


def test_offline_gpu_queues_then_completes(setup):
    a = setup
    m = a.post("/api/matters", json={"name": "m"}).json()
    jid = submit(a, m["id"])
    gpu = FakeProvider("local_gpu", online=False)
    assert run(gpu) is True
    j = state(a, jid)
    assert j["state"] == "WAITING_FOR_GPU" and "Waiting for private GPU node" in j["status_message"]
    assert gpu.chat_calls == 0
    # not due yet -> not picked up again immediately
    assert run(gpu) is False
    with session_scope() as db:
        db.get(Job, __import__("uuid").UUID(jid)).next_attempt_at = None
    gpu.online = True
    run(gpu)
    j = state(a, jid)
    assert j["state"] == "COMPLETE" and j["result"]["content"] == "answer" and j["provider_used"] == "local_gpu"


def test_role_routing_uses_configured_models(setup):
    a = setup
    m = a.post("/api/matters", json={"name": "m"}).json()
    gpu = FakeProvider("local_gpu")
    submit(a, m["id"], task="extraction")
    submit(a, m["id"], task="research")
    submit(a, m["id"], role="fast")
    run(gpu), run(gpu), run(gpu)
    assert gpu.models_seen == ["fast-m", "deep-m", "fast-m"]


def test_cancel_waiting_job(setup):
    a = setup
    m = a.post("/api/matters", json={"name": "m"}).json()
    jid = submit(a, m["id"])
    run(FakeProvider(online=False))
    assert a.post(f"/api/jobs/{jid}/cancel").json()["state"] == "CANCELED"
    assert a.post(f"/api/jobs/{jid}/cancel").status_code == 409


def _enable_fallback(monkeypatch, budget="5"):
    monkeypatch.setenv("LLM_FALLBACK_PROVIDER", "openai_compatible")
    monkeypatch.setenv("LLM_FALLBACK_BASE_URL", "https://llm.example.com")
    monkeypatch.setenv("LLM_FALLBACK_MODEL", "ext-model")
    monkeypatch.setenv("EXTERNAL_LLM_MONTHLY_BUDGET_USD", budget)
    monkeypatch.setenv("EXTERNAL_LLM_PRICE_PER_1K_TOKENS_USD", "0.01")
    get_settings.cache_clear()


def test_no_silent_fallback_by_default(setup, monkeypatch):
    a = setup
    _enable_fallback(monkeypatch)  # globally configured, but the matter did not opt in
    m = a.post("/api/matters", json={"name": "m", "privacy_mode": "standard"}).json()
    jid = submit(a, m["id"])
    ext = FakeProvider("ext", external=True)
    run(FakeProvider(online=False), ext)
    assert state(a, jid)["state"] == "WAITING_FOR_GPU" and ext.chat_calls == 0


def test_fallback_blocked_for_local_only_even_if_row_tampered(setup, monkeypatch):
    a = setup
    _enable_fallback(monkeypatch)
    m = a.post("/api/matters", json={"name": "m", "privacy_mode": "local_only"}).json()
    with session_scope() as db:  # simulate a bad write that bypassed API validation
        db.get(Matter, __import__("uuid").UUID(m["id"])).llm_fallback_mode = "allowed"
    jid = submit(a, m["id"])
    ext = FakeProvider("ext", external=True)
    run(FakeProvider(online=False), ext)
    assert state(a, jid)["state"] == "WAITING_FOR_GPU" and ext.chat_calls == 0


def test_fallback_allowed_records_cost_and_respects_budget(setup, monkeypatch):
    a = setup
    _enable_fallback(monkeypatch, budget="1")
    m = a.post("/api/matters", json={"name": "m", "privacy_mode": "standard", "llm_fallback_mode": "allowed"}).json()
    ext = FakeProvider("ext", external=True)
    jid = submit(a, m["id"])
    run(FakeProvider(online=False), ext)
    j = state(a, jid)
    assert j["state"] == "COMPLETE" and j["provider_used"] == "ext" and ext.models_seen == ["ext-model"]
    with session_scope() as db:
        u = db.query(ProviderUsage).one()
        assert u.external and abs(u.cost_usd - 0.002) < 1e-9
        u.cost_usd = 1.0  # budget exhausted
    jid2 = submit(a, m["id"])
    run(FakeProvider(online=False), ext)
    assert state(a, jid2)["state"] == "WAITING_FOR_GPU" and ext.chat_calls == 1


def test_zero_budget_blocks_fallback(setup, monkeypatch):
    a = setup
    _enable_fallback(monkeypatch, budget="0")
    m = a.post("/api/matters", json={"name": "m", "privacy_mode": "standard", "llm_fallback_mode": "allowed"}).json()
    jid = submit(a, m["id"])
    ext = FakeProvider("ext", external=True)
    run(FakeProvider(online=False), ext)
    assert state(a, jid)["state"] == "WAITING_FOR_GPU" and ext.chat_calls == 0


def test_ask_mode_needs_per_job_approval(setup, monkeypatch):
    a = setup
    _enable_fallback(monkeypatch)
    m = a.post("/api/matters", json={"name": "m", "privacy_mode": "standard", "llm_fallback_mode": "ask"}).json()
    jid = submit(a, m["id"])
    ext = FakeProvider("ext", external=True)
    run(FakeProvider(online=False), ext)
    j = state(a, jid)
    assert j["state"] == "WAITING_FOR_GPU" and j["needs_fallback_approval"] and ext.chat_calls == 0
    a.post(f"/api/jobs/{jid}/approve-fallback")
    with session_scope() as db:
        db.get(Job, __import__("uuid").UUID(jid)).next_attempt_at = None
    run(FakeProvider(online=False), ext)
    assert state(a, jid)["state"] == "COMPLETE" and ext.chat_calls == 1


def test_provider_error_retries_then_fails(setup):
    a = setup
    m = a.post("/api/matters", json={"name": "m"}).json()

    class Boom(FakeProvider):
        async def chat(self, *a, **k):
            raise RuntimeError("model crashed")

    jid = submit(a, m["id"])
    for _ in range(5):
        with session_scope() as db:
            db.get(Job, __import__("uuid").UUID(jid)).next_attempt_at = None
        run(Boom())
    j = state(a, jid)
    assert j["state"] == "FAILED" and "model crashed" in j["error"] and j["attempts"] == 5


def test_state_machine_rejects_illegal_transitions():
    j = Job(state="COMPLETE")
    with pytest.raises(InvalidTransition):
        transition(j, "RUNNING")


def test_privacy_helpers():
    m = Matter(privacy_mode="local_only", external_embedding_enabled=True, llm_fallback_mode="allowed")
    assert not external_embedding_allowed(m) and effective_fallback_mode(m) == "disabled"
    m = Matter(privacy_mode="private", external_embedding_enabled=False)
    assert not external_embedding_allowed(m)
    m.external_embedding_enabled = True
    assert external_embedding_allowed(m)
    assert external_embedding_allowed(Matter(privacy_mode="standard", external_embedding_enabled=False))


def test_signing_roundtrip_and_fixed_vector():
    h = sign("s3cret", "POST", "/v1/chat/completions", b"{}", timestamp=1700000000)
    # Fixed vector: gateway/signing.py must produce the same value (asserted in the gateway tests).
    assert h["X-Signature"] == "2c5ca3b0650dbc45291128d27a37c701d95945dd0c6392ddf5c8b5455e96d82e"
    import time
    now = sign("s3cret", "GET", "/health", b"")
    assert verify("s3cret", "GET", "/health", b"", now["X-Timestamp"], now["X-Signature"])
    assert not verify("other", "GET", "/health", b"", now["X-Timestamp"], now["X-Signature"])
    assert not verify("s3cret", "GET", "/health", b"x", now["X-Timestamp"], now["X-Signature"])
    old = sign("s3cret", "GET", "/health", b"", timestamp=int(time.time()) - 500)
    assert not verify("s3cret", "GET", "/health", b"", old["X-Timestamp"], old["X-Signature"])
