"""Plan metering of AI work started inside LegalAI (legalai/quota.py) and the private usage endpoint."""
import httpx
import pytest
from fastapi import HTTPException

from legalai import quota
from legalai.config import get_settings
from legalai.db import session_scope
from legalai.models import DocumentChunk, Job, ProviderUsage
from tests.test_ingestion import CONTRACT
from tests.test_retrieval import emb, drain, mk_matter, upload  # noqa: F401
from tests.test_review import setup  # noqa: F401

TOKEN = "q" * 40
URL = "http://shell.internal/api/internal/quota/consume"


def configure(monkeypatch, url=URL, token=TOKEN):
    monkeypatch.setenv("PLAN_QUOTA_URL", url)
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", token)
    get_settings.cache_clear()


class FakeShell:
    def __init__(self, status=200, message=""):
        self.status, self.message, self.calls = status, message, []

    def __call__(self, url, token, user_id):
        self.calls.append((url, token, user_id))
        return self.status, self.message


# ---- helper ---------------------------------------------------------------------------------------------------
def test_noop_when_url_unset(monkeypatch):
    monkeypatch.setenv("PLAN_QUOTA_URL", "")
    get_settings.cache_clear()
    monkeypatch.setattr(quota, "_post", lambda *a: pytest.fail("must not call the shell"))
    quota.consume_ai_quota("u1")


def test_sends_user_and_token_and_allows(monkeypatch):
    configure(monkeypatch)
    shell = FakeShell(200)
    monkeypatch.setattr(quota, "_post", shell)
    quota.consume_ai_quota("u1")
    assert shell.calls == [(URL, TOKEN, "u1")]


def test_402_becomes_http_402_with_the_plan_message(monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(quota, "_post", FakeShell(402, "You have used all of the 20 AI requests included in your Free plan this month."))
    with pytest.raises(HTTPException) as e:
        quota.consume_ai_quota("u1")
    assert e.value.status_code == 402 and "20 AI requests" in e.value.detail


@pytest.mark.parametrize("status", [500, 502, 404, 401, 429])
def test_fails_open_on_other_http_statuses(monkeypatch, status):
    configure(monkeypatch)
    monkeypatch.setattr(quota, "_post", FakeShell(status))
    quota.consume_ai_quota("u1")


@pytest.mark.parametrize("exc", [httpx.ConnectTimeout("t"), httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), RuntimeError("boom")])
def test_fails_open_on_transport_errors(monkeypatch, exc, caplog):
    configure(monkeypatch)

    def boom(*a):
        raise exc

    monkeypatch.setattr(quota, "_post", boom)
    quota.consume_ai_quota("u1")
    assert TOKEN not in caplog.text and URL not in caplog.text


def test_real_http_layer_uses_timeout_no_redirects_and_token(monkeypatch):
    seen = {}

    def fake_post(url, json, headers, timeout, follow_redirects):
        seen.update(url=url, json=json, headers=headers, timeout=timeout, follow=follow_redirects)
        return httpx.Response(402, json={"allowed": False, "message": "limit reached"})

    monkeypatch.setattr(httpx, "post", fake_post)
    assert quota._post(URL, TOKEN, "u9") == (402, "limit reached")
    assert seen["timeout"] == 3.0 and seen["follow"] is False and seen["headers"] == {"X-Internal-Token": TOKEN}
    assert seen["json"] == {"userId": "u9", "metric": "ai_request", "amount": 1}


def test_is_shell_metered(monkeypatch):
    configure(monkeypatch)
    assert quota.is_shell_metered(TOKEN) and not quota.is_shell_metered("nope") and not quota.is_shell_metered(None)
    configure(monkeypatch, token="")
    assert not quota.is_shell_metered("")


# ---- entry points: counted once per action ----------------------------------------------------------------------
def first_chunk_id():
    with session_scope() as db:
        return str(db.query(DocumentChunk).filter(DocumentChunk.text.like("%terminate for convenience%")).first().id)


def test_each_entry_point_counts_exactly_once(make_api, emb, monkeypatch):
    configure(monkeypatch)
    shell = FakeShell(200)
    monkeypatch.setattr(quota, "_post", shell)
    a, m, d = setup(make_api)
    shell.calls.clear()  # setup may have run its own jobs; count only what follows

    def one(label, resp, ok=(200, 201, 202)):
        assert resp.status_code in ok, (label, resp.text)
        assert len(shell.calls) == 1, f"{label}: expected one quota call, got {len(shell.calls)}"
        shell.calls.clear()

    one("research", a.post("/api/research", json={"matter_id": m["id"], "question": "What is the notice period?"}))
    one("review", a.post("/api/contracts/review", json={"document_id": d["id"]}))
    one("draft", a.post("/api/drafts", json={"matter_id": m["id"], "mode": "draft_from_scratch", "instructions": "Draft a short NDA clause"}))
    one("redline", a.post("/api/redlines", json={"chunk_id": first_chunk_id(), "instruction": "Extend the notice period"}))
    one("inference", a.post("/api/inference", json={"matter_id": m["id"], "messages": [{"role": "user", "content": "hi"}]}))

    v2 = CONTRACT.replace("thirty days written notice", "sixty days written notice")
    upload(a, m["id"], "v2.txt", v2.encode(), document_id=d["id"])
    drain()
    shell.calls.clear()
    vs = a.get(f"/api/documents/{d['id']}/versions").json()
    one("comparison with summary", a.post("/api/comparisons", json={"version_a": vs[0]["id"], "version_b": vs[1]["id"], "summarize": True}))
    # No AI, no count: a plain comparison, reads, and polling a job.
    assert a.post("/api/comparisons", json={"version_a": vs[0]["id"], "version_b": vs[1]["id"]}).status_code == 201
    assert a.get("/api/jobs").status_code == 200
    assert shell.calls == []


def test_running_the_pipeline_does_not_count_again(make_api, emb, monkeypatch):
    configure(monkeypatch)
    shell = FakeShell(200)
    monkeypatch.setattr(quota, "_post", shell)
    a, m, d = setup(make_api)
    shell.calls.clear()
    assert a.post("/api/contracts/review", json={"document_id": d["id"]}).status_code == 202
    assert len(shell.calls) == 1
    drain()  # the worker runs the review's internal sub-steps; it never calls the helper
    assert len(shell.calls) == 1


def test_shell_tool_inference_is_not_counted_twice(make_api, emb, monkeypatch):
    configure(monkeypatch)
    shell = FakeShell(200)
    monkeypatch.setattr(quota, "_post", shell)
    a = make_api("admin@example.com")
    m = mk_matter(a)
    body = {"matter_id": m["id"], "messages": [{"role": "user", "content": "hi"}], "task": "tool"}
    assert a.c.post("/api/inference", json=body, headers={"x-csrf-token": a.csrf, "X-Internal-Token": TOKEN}).status_code == 202
    assert shell.calls == []
    # A wrong token does not skip metering.
    assert a.c.post("/api/inference", json=body, headers={"x-csrf-token": a.csrf, "X-Internal-Token": "x" * 40}).status_code == 202
    assert len(shell.calls) == 1


def test_402_reaches_the_response_and_nothing_is_queued(make_api, emb, monkeypatch):
    configure(monkeypatch)
    monkeypatch.setattr(quota, "_post", FakeShell(402, "Your Free plan has no AI requests left this month."))
    a, m, d = setup(make_api)
    with session_scope() as db:
        before = db.query(Job).count()
    calls = [
        a.post("/api/research", json={"matter_id": m["id"], "question": "What is the notice period?"}),
        a.post("/api/contracts/review", json={"document_id": d["id"]}),
        a.post("/api/drafts", json={"matter_id": m["id"], "mode": "draft_from_scratch", "instructions": "Draft a short NDA clause"}),
        a.post("/api/redlines", json={"chunk_id": first_chunk_id(), "instruction": "Extend the notice period"}),
        a.post("/api/inference", json={"matter_id": m["id"], "messages": [{"role": "user", "content": "hi"}]}),
    ]
    for r in calls:
        assert r.status_code == 402 and r.json()["detail"] == "Your Free plan has no AI requests left this month."
    with session_scope() as db:
        assert db.query(Job).count() == before


def test_shell_outage_never_blocks_legal_work(make_api, emb, monkeypatch):
    configure(monkeypatch)

    def down(*a):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(quota, "_post", down)
    a, m, d = setup(make_api)
    assert a.post("/api/research", json={"matter_id": m["id"], "question": "What is the notice period?"}).status_code == 202
    assert a.post("/api/contracts/review", json={"document_id": d["id"]}).status_code == 202


def test_unset_url_leaves_everything_unmetered(make_api, emb, monkeypatch):
    monkeypatch.setenv("PLAN_QUOTA_URL", "")
    get_settings.cache_clear()
    monkeypatch.setattr(quota, "_post", lambda *a: pytest.fail("must not call the shell"))
    a = make_api("admin@example.com")
    m = mk_matter(a)
    assert a.post("/api/inference", json={"matter_id": m["id"], "messages": [{"role": "user", "content": "hi"}]}).status_code == 202


# ---- private usage endpoint -------------------------------------------------------------------------------------
def usage_client(monkeypatch, token=TOKEN):
    monkeypatch.setenv("INTERNAL_PROVISION_TOKEN", token)
    get_settings.cache_clear()
    from fastapi.testclient import TestClient
    from legalai.main import create_app
    from legalai.routers import usage_internal
    usage_internal.bad_token_limiter.reset()
    return TestClient(create_app())


def test_usage_endpoint_404_when_token_unset_or_short(monkeypatch):
    for tok in ("", "short"):
        c = usage_client(monkeypatch, tok)
        assert c.get("/api/internal/usage?all=1", headers={"X-Internal-Token": tok}).status_code == 404
        assert c.get("/api/internal/usage?all=1").status_code == 404


def test_usage_endpoint_token_gate(monkeypatch):
    c = usage_client(monkeypatch)
    assert c.get("/api/internal/usage?all=1").status_code == 401
    assert c.get("/api/internal/usage?all=1", headers={"X-Internal-Token": "wrong"}).status_code == 401
    assert c.get("/api/internal/usage?all=1", headers={"X-Internal-Token": TOKEN[:-1]}).status_code == 401
    assert c.get("/api/internal/usage?all=1", headers={"X-Internal-Token": TOKEN}).status_code == 200
    assert c.get("/api/internal/usage", headers={"X-Internal-Token": TOKEN}).status_code == 422  # needs a user or all=1


def test_usage_endpoint_totals_per_user_and_platform(make_api, monkeypatch):
    a = make_api("admin@example.com")
    bob = make_api("bob@example.com")
    m = mk_matter(a)
    uid = a.get("/api/auth/me").json()["user"]["id"]
    j = a.post("/api/inference", json={"matter_id": m["id"], "messages": [{"role": "user", "content": "hi"}]}).json()
    with session_scope() as db:
        job = db.get(Job, j["id"])
        db.add(ProviderUsage(job_id=job.id, matter_id=job.matter_id, provider="local_gpu", kind="llm", model="fast-m",
                             external=False, prompt_tokens=100, completion_tokens=40, cost_usd=0.0))
        db.add(Job(job_type="backup", payload={}, state="NEW"))  # a system job must not count
    c = usage_client(monkeypatch)
    h = {"X-Internal-Token": TOKEN}
    mine = c.get(f"/api/internal/usage?user_id={uid}", headers=h).json()
    assert mine["requests"] == 1 and mine["tokens"] == 140 and mine["prompt_tokens"] == 100 and mine["cost_usd"] == 0.0
    other = c.get(f"/api/internal/usage?user_id={bob.get('/api/auth/me').json()['user']['id']}", headers=h).json()
    assert other["requests"] == 0 and other["tokens"] == 0
    assert c.get("/api/internal/usage?all=1", headers=h).json()["requests"] == 1
    assert c.get("/api/internal/usage?all=1&since=2999-01-01", headers=h).json()["requests"] == 0
    assert c.get("/api/internal/usage?all=1&since=garbage", headers=h).status_code == 422
