import json

import httpx
import pytest
from fastapi.testclient import TestClient

from gateway import app as gw
from gateway.signing import sign

TOKEN = "t" * 32


class FakeOllama:
    """Replaces httpx.AsyncClient inside the gateway; records what would reach Ollama."""
    last_json = None
    up = True

    def __init__(self, *a, **k): ...
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False

    async def get(self, url, **k):
        if not FakeOllama.up:
            raise httpx.ConnectError("down")
        return httpx.Response(200, json={"models": [{"name": "fast-m"}, {"name": "other"}]},
                              request=httpx.Request("GET", url))

    async def post(self, url, json=None, **k):
        if not FakeOllama.up:
            raise httpx.ConnectError("down")
        FakeOllama.last_json = json
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]},
                              request=httpx.Request("POST", url))


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(gw.httpx, "AsyncClient", FakeOllama)
    FakeOllama.up, FakeOllama.last_json = True, None
    return TestClient(gw.create_app(gw.Settings(token=TOKEN, allowed_models="fast-m,deep-m", rate_limit_per_min=5)))


def call(client, method, path, payload=None, token=TOKEN, sign_with=TOKEN, **hdr):
    body = json.dumps(payload).encode() if payload is not None else b""
    h = {"Authorization": f"Bearer {token}", **sign(sign_with, method, path, body), **hdr}
    return client.request(method, path, content=body or None, headers=h)


def test_requires_token_and_signature(client):
    assert client.get("/health").status_code == 401
    assert call(client, "GET", "/health", token="wrong").status_code == 401
    assert call(client, "GET", "/health", sign_with="wrong-secret").status_code == 401
    assert call(client, "GET", "/health").status_code == 200


def test_replay_rejected(client):
    h = {"Authorization": f"Bearer {TOKEN}", **sign(TOKEN, "GET", "/models", b"")}
    assert client.get("/models", headers=h).status_code == 200
    assert client.get("/models", headers=h).status_code == 401


def test_stale_timestamp_rejected(client):
    h = {"Authorization": f"Bearer {TOKEN}", **sign(TOKEN, "GET", "/models", b"", timestamp=1000)}
    assert client.get("/models", headers=h).status_code == 401


def test_models_limited_to_allowlist_and_installed(client):
    assert call(client, "GET", "/models").json() == {"models": ["fast-m"]}


def test_model_allowlist_and_param_stripping(client):
    msg = [{"role": "user", "content": "hi"}]
    assert call(client, "POST", "/v1/chat/completions", {"model": "evil", "messages": msg}).status_code == 403
    r = call(client, "POST", "/v1/chat/completions",
             {"model": "fast-m", "messages": msg, "temperature": 0.1, "keep_alive": -1, "options": {"num_ctx": 999999},
              "tools": [1]})
    assert r.status_code == 200
    assert FakeOllama.last_json == {"model": "fast-m", "messages": msg, "stream": False, "temperature": 0.1}


def test_body_size_limit(client):
    big = {"model": "fast-m", "messages": [{"role": "user", "content": "x" * 3_000_000}]}
    assert call(client, "POST", "/v1/chat/completions", big).status_code == 413


def test_rate_limit(client):
    import time
    now = int(time.time())  # distinct timestamps so identical requests are not rejected as replays
    codes = [client.get("/models", headers={"Authorization": f"Bearer {TOKEN}",
                                            **sign(TOKEN, "GET", "/models", b"", now + i)}).status_code
             for i in range(7)]
    assert codes[:5] == [200] * 5 and 429 in codes[5:]


def test_backend_down_returns_503(client):
    FakeOllama.up = False
    assert call(client, "GET", "/health").status_code == 503
    msg = [{"role": "user", "content": "hi"}]
    assert call(client, "POST", "/v1/chat/completions", {"model": "fast-m", "messages": msg}).status_code == 503


def test_refuses_to_start_without_strong_token():
    with pytest.raises(RuntimeError):
        gw.create_app(gw.Settings(token="short"))


def test_signing_matches_api_vector():
    assert sign("s3cret", "POST", "/v1/chat/completions", b"{}", 1700000000)["X-Signature"] == \
        "2c5ca3b0650dbc45291128d27a37c701d95945dd0c6392ddf5c8b5455e96d82e"


def test_embeddings_allowlist_and_validation(client, monkeypatch):
    async def post(self, url, json=None, **k):
        FakeOllama.last_json = json
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [0.1]}]}, request=httpx.Request("POST", url))
    monkeypatch.setattr(FakeOllama, "post", post)
    assert call(client, "POST", "/v1/embeddings", {"model": "evil", "input": ["x"]}).status_code == 403
    assert call(client, "POST", "/v1/embeddings", {"model": "fast-m", "input": []}).status_code == 400
    assert call(client, "POST", "/v1/embeddings", {"model": "fast-m", "input": [1]}).status_code == 400
    r = call(client, "POST", "/v1/embeddings", {"model": "fast-m", "input": "hello", "options": {"x": 1}})
    assert r.status_code == 200 and FakeOllama.last_json == {"model": "fast-m", "input": ["hello"]}
    assert client.post("/v1/embeddings", json={}).status_code == 401
