import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pull_agent as pa  # noqa: E402

SEEN = {}


def ollama():
    def handler(req: httpx.Request):
        SEEN["path"], SEEN["body"] = req.url.path, json.loads(req.content) if req.content else None
        if req.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": "fast-m"}, {"name": "unlisted"}]})
        if SEEN.get("fail"):
            return httpx.Response(500)
        return httpx.Response(200, json={"ok": True})
    return httpx.Client(base_url="http://ollama", transport=httpx.MockTransport(handler))


def test_chat_params_are_filtered_and_stream_forced_off():
    SEEN.clear()
    out = pa.process_request({"kind": "chat", "payload": {"model": "fast-m", "messages": [{"role": "user", "content": "x"}],
                                                          "params": {"temperature": 0.2, "keep_alive": -1, "options": {"num_ctx": 1}}}}, ollama(), {"fast-m"})
    assert out == {"ok": True} and SEEN["path"] == "/v1/chat/completions"
    assert SEEN["body"] == {"model": "fast-m", "messages": [{"role": "user", "content": "x"}], "stream": False, "temperature": 0.2}


def test_model_allowlist_and_validation_never_raise():
    assert pa.process_request({"kind": "chat", "payload": {"model": "evil", "messages": []}}, ollama(), {"fast-m"}) == {"error": "Model not allowed on this node"}
    assert "error" in pa.process_request({"kind": "embeddings", "payload": {"model": "fast-m", "input": []}}, ollama(), {"fast-m"})
    assert "error" in pa.process_request({"kind": "embeddings", "payload": {"model": "fast-m", "input": [1]}}, ollama(), {"fast-m"})
    assert "Unknown request kind" in pa.process_request({"kind": "shell", "payload": {"model": "fast-m"}}, ollama(), {"fast-m"})["error"]
    assert "Malformed" in pa.process_request({"kind": "chat", "payload": {}}, ollama(), {"fast-m"})["error"]
    SEEN["fail"] = True
    assert "HTTP 500" in pa.process_request({"kind": "chat", "payload": {"model": "fast-m", "messages": []}}, ollama(), {"fast-m"})["error"]
    SEEN.clear()


def test_ollama_down_is_reported_not_raised():
    def boom(req):
        raise httpx.ConnectError("down")
    c = httpx.Client(base_url="http://ollama", transport=httpx.MockTransport(boom))
    assert "unreachable" in pa.process_request({"kind": "chat", "payload": {"model": "fast-m", "messages": []}}, c, {"fast-m"})["error"]
    assert pa.installed_models(c, {"fast-m"}) == []


def test_installed_models_intersect_allowlist():
    assert pa.installed_models(ollama(), {"fast-m", "deep-m"}) == ["fast-m"]
