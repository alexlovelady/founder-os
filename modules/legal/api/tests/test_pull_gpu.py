"""Pull mode: the home node polls the API; nothing inbound is exposed."""
import asyncio

import pytest

from legalai.config import get_settings
from legalai.db import session_scope
from legalai.models import GpuNode, GpuRequest
from legalai.providers.base import ProviderError, ProviderUnavailable
from legalai.providers.pull_gpu import PulledEmbeddingProvider, PulledGpuProvider, purge_stale_requests

TOKEN = "node-secret-for-tests-1234567890"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
NODE = {"node_id": "test-node", "gpu": "RTX 5070 Ti", "models": ["fast-m", "deep-m"], "vram_free_mb": 9000}
VEC = [0.5] * 1024


@pytest.fixture
def settings(monkeypatch):
    monkeypatch.setenv("GPU_MODE", "pull")
    monkeypatch.setenv("GPU_CLAIM_TIMEOUT_S", "2")
    monkeypatch.setenv("GPU_REQUEST_TIMEOUT_S", "6")
    get_settings.cache_clear()
    return get_settings()


def heartbeat(client):
    assert client.post("/api/gpu/heartbeat", json=NODE, headers=AUTH).status_code == 200


def fake_agent(client, answer, once=True):
    """What the Windows agent does: claim -> run locally -> post result."""
    def run():
        for _ in range(40):
            r = client.post("/api/gpu/claim", json=NODE, headers=AUTH, timeout=5).json()
            if r["request"]:
                req = r["request"]
                out = answer(req)
                body = {"node_id": "test-node", **({"error": out["error"]} if "error" in out else {"result": out})}
                assert client.post(f"/api/gpu/requests/{req['id']}/result", json=body, headers=AUTH).status_code == 200
                return req
        raise AssertionError("no request claimed")
    return run


def chat_answer(req):
    assert req["kind"] == "chat" and req["payload"]["model"] == "deep-m"
    return {"model": "deep-m", "choices": [{"message": {"content": "pulled answer"}}], "usage": {"prompt_tokens": 3, "completion_tokens": 2}}


def test_node_endpoints_require_the_node_token(client):
    assert client.post("/api/gpu/claim", json=NODE).status_code == 401
    assert client.post("/api/gpu/claim", json=NODE, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.post("/api/gpu/requests/00000000-0000-0000-0000-000000000000/result", json={"node_id": "x"}).status_code == 401


def test_offline_node_is_unavailable_not_hung(client, settings):
    p = PulledGpuProvider(settings)
    with pytest.raises(ProviderUnavailable):
        asyncio.run(p.health())
    with pytest.raises(ProviderUnavailable):
        asyncio.run(p.chat([{"role": "user", "content": "hi"}], "deep-m"))


def test_chat_roundtrip_and_request_row_is_deleted(client, settings):
    heartbeat(client)
    p = PulledGpuProvider(settings)

    async def go():
        agent = asyncio.to_thread(fake_agent(client, chat_answer))
        res, req = await asyncio.gather(p.chat([{"role": "user", "content": "hi"}], "deep-m", temperature=0.1, evil_param=1), agent)
        return res, req

    res, req = asyncio.run(go())
    assert res.content == "pulled answer" and res.prompt_tokens == 3 and res.completion_tokens == 2
    assert req["payload"]["params"] == {"temperature": 0.1}                     # unsupported parameters never reach the node
    with session_scope() as db:
        assert db.query(GpuRequest).count() == 0                                # prompts do not linger in the database
    assert asyncio.run(p.health())["status"] == "ok" and asyncio.run(p.list_models()) == ["fast-m", "deep-m"]


def test_embeddings_roundtrip(client, settings):
    heartbeat(client)
    p = PulledEmbeddingProvider(settings, "qwen3-embedding:0.6b", batch_size=2)

    def answer(req):
        assert req["kind"] == "embeddings"
        return {"data": [{"index": i, "embedding": VEC} for i in range(len(req["payload"]["input"]))]}

    async def go():
        a1 = asyncio.to_thread(fake_agent(client, answer))
        a2 = asyncio.to_thread(fake_agent(client, answer))
        vecs, *_ = await asyncio.gather(p.embed_documents(["a", "b", "c"]), a1, a2)
        return vecs
    assert len(asyncio.run(go())) == 3
    bad = PulledEmbeddingProvider(settings, "m")

    async def wrong_dim():
        agent = asyncio.to_thread(fake_agent(client, lambda r: {"data": [{"index": 0, "embedding": [0.1] * 10}]}))
        await asyncio.gather(bad.embed_query("x"), agent)
    with pytest.raises(ProviderError, match="dims"):
        asyncio.run(wrong_dim())


def test_node_error_surfaces_as_provider_error(client, settings):
    heartbeat(client)

    async def go():
        agent = asyncio.to_thread(fake_agent(client, lambda r: {"error": "model not allowed"}))
        await asyncio.gather(PulledGpuProvider(settings).chat([{"role": "user", "content": "x"}], "deep-m"), agent)
    with pytest.raises(ProviderError, match="model not allowed"):
        asyncio.run(go())


def test_unclaimed_request_times_out_as_unavailable_and_is_removed(client, settings):
    heartbeat(client)                                                           # node looks online but never claims
    with pytest.raises(ProviderUnavailable, match="did not pick up"):
        asyncio.run(PulledGpuProvider(settings).chat([{"role": "user", "content": "x"}], "deep-m"))
    with session_scope() as db:
        assert db.query(GpuRequest).count() == 0


def test_only_the_claiming_node_can_post_a_result_and_only_once(client, settings):
    heartbeat(client)
    with session_scope() as db:
        db.add(GpuRequest(kind="chat", payload={"model": "deep-m", "messages": []}))
    req = client.post("/api/gpu/claim", json=NODE, headers=AUTH, timeout=5).json()["request"]
    rid = req["id"]
    assert client.post(f"/api/gpu/requests/{rid}/result", json={"node_id": "other-node", "result": {}}, headers=AUTH).status_code == 404
    assert client.post(f"/api/gpu/requests/{rid}/result", json={"node_id": "test-node", "result": {"x": 1}}, headers=AUTH).status_code == 200
    assert client.post(f"/api/gpu/requests/{rid}/result", json={"node_id": "test-node", "result": {"x": 2}}, headers=AUTH).status_code == 404
    assert client.post("/api/gpu/requests/not-a-uuid/result", json={"node_id": "test-node"}, headers=AUTH).status_code == 404


def test_requests_are_claimed_in_order_and_once(client, settings):
    heartbeat(client)
    with session_scope() as db:
        for i in range(3):
            db.add(GpuRequest(kind="chat", payload={"i": i}))
    seen = [client.post("/api/gpu/claim", json=NODE, headers=AUTH, timeout=5).json()["request"]["payload"]["i"] for _ in range(3)]
    assert seen == [0, 1, 2]


def test_stale_heartbeat_marks_node_offline_and_purge_cleans_old_rows(client, settings):
    heartbeat(client)
    with session_scope() as db:
        db.get(GpuNode, "test-node").last_heartbeat_at = None
        from datetime import datetime, timedelta, timezone
        r = GpuRequest(kind="chat", payload={})
        db.add(r)
        db.flush()
        r.created_at = datetime.now(timezone.utc) - timedelta(hours=2)
    with pytest.raises(ProviderUnavailable):
        asyncio.run(PulledGpuProvider(settings).health())
    assert purge_stale_requests(settings) == 1


def test_job_runner_waits_when_pull_node_offline_and_completes_when_it_returns(make_api, settings, client):
    """End to end through the real job runner using pull mode (no fake provider)."""
    from legalai.jobs.runner import process_one
    a = make_api("admin@example.com")
    m = a.post("/api/matters", json={"name": "m"}).json()
    jid = a.post("/api/inference", json={"matter_id": m["id"], "role": "deep", "messages": [{"role": "user", "content": "hi"}]}).json()["id"]
    assert asyncio.run(process_one(settings)) is True
    j = a.get(f"/api/jobs/{jid}").json()
    assert j["state"] == "WAITING_FOR_GPU" and "Waiting for private GPU node" in j["status_message"]
    heartbeat(client)
    with session_scope() as db:
        from legalai.models import Job
        import uuid
        db.get(Job, uuid.UUID(jid)).next_attempt_at = None

    async def go():
        agent = asyncio.to_thread(fake_agent(client, chat_answer))
        await asyncio.gather(process_one(settings), agent)
    asyncio.run(go())
    j = a.get(f"/api/jobs/{jid}").json()
    assert j["state"] == "COMPLETE" and j["result"]["content"] == "pulled answer" and j["provider_used"] == "local_gpu"
