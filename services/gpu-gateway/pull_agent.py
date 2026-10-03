"""Pull-mode GPU agent for Windows. Replaces the inbound gateway + tunnel: this program only makes OUTBOUND HTTPS calls.

Loop: POST /api/gpu/claim (long poll; doubles as the heartbeat) -> run the request on local Ollama -> POST the result.
Nothing listens on your network, so there is no tunnel, no public hostname and no inbound token to leak.

Env (or .env next to this file):
  GATEWAY_TOKEN           shared secret, same value as GPU_NODE_TOKEN on Railway
  API_URL                 https://your-app.up.railway.app
  NODE_ID                 e.g. home-5070ti (must match GPU_NODE_ID on Railway)
  GATEWAY_ALLOWED_MODELS  comma separated allowlist (requests for other models are refused)
  OLLAMA_URL              default http://127.0.0.1:11434
"""
import ctypes
import logging
import os
import subprocess
import sys
import time

import httpx

ALLOWED_PARAMS = {"temperature", "top_p", "max_tokens", "stop", "seed", "response_format"}
ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
log = logging.getLogger("pull-agent")


def load_env_file() -> None:
    f = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(f):
        for line in open(f, encoding="utf-8"):
            k, sep, v = line.strip().partition("=")
            if sep and k and not k.startswith("#"):
                os.environ.setdefault(k, v)


def keep_awake(active: bool) -> None:
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if active else 0))


def gpu_info() -> dict:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10).stdout
        name, total, free = [x.strip() for x in out.splitlines()[0].split(",")]
        return {"gpu": name, "vram_total_mb": int(total), "vram_free_mb": int(free)}
    except Exception:  # noqa: BLE001
        return {}


def process_request(req: dict, ollama: httpx.Client, allowed: set[str]) -> dict:
    """Run one claimed request locally. Returns the result dict, or {"error": ...}. Never raises."""
    try:
        kind, p = req["kind"], req["payload"]
        model = p["model"]
        if model not in allowed:
            return {"error": "Model not allowed on this node"}
        if kind == "chat":
            body = {"model": model, "messages": p["messages"], "stream": False,
                    **{k: v for k, v in (p.get("params") or {}).items() if k in ALLOWED_PARAMS}}
            r = ollama.post("/v1/chat/completions", json=body)
        elif kind == "embeddings":
            inp = p["input"]
            if not isinstance(inp, list) or not inp or not all(isinstance(x, str) for x in inp):
                return {"error": "input must be a non-empty list of strings"}
            r = ollama.post("/v1/embeddings", json={"model": model, "input": inp})
        else:
            return {"error": f"Unknown request kind {kind}"}
        if r.status_code != 200:
            return {"error": f"Ollama returned HTTP {r.status_code}"}
        return r.json()
    except httpx.HTTPError as e:
        return {"error": f"Ollama unreachable: {type(e).__name__}"}
    except (KeyError, TypeError, ValueError) as e:
        return {"error": f"Malformed request: {type(e).__name__}"}


def installed_models(ollama: httpx.Client, allowed: set[str]) -> list[str]:
    try:
        names = {m["name"] for m in ollama.get("/api/tags").json().get("models", [])}
        return sorted(allowed & names)
    except (httpx.HTTPError, ValueError, KeyError):
        return []


def run_forever() -> None:
    load_env_file()
    token, api = os.environ["GATEWAY_TOKEN"], os.environ["API_URL"].rstrip("/")
    node = os.environ.get("NODE_ID", "home-gpu")
    allowed = {m.strip() for m in os.environ.get("GATEWAY_ALLOWED_MODELS", "").split(",") if m.strip()}
    headers = {"Authorization": f"Bearer {token}"}
    ollama = httpx.Client(base_url=os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434"), timeout=900)
    backoff = 2
    with httpx.Client(base_url=api, headers=headers, timeout=httpx.Timeout(40, connect=15)) as cloud:
        while True:
            models = installed_models(ollama, allowed)
            hb = {"node_id": node, "status": "online" if models else "degraded", "models": models, "active_jobs": 0, **gpu_info()}
            try:
                r = cloud.post("/api/gpu/claim", json=hb)
                r.raise_for_status()
                backoff = 2
                req = r.json().get("request")
                if not req:
                    continue
                keep_awake(True)
                try:
                    out = process_request(req, ollama, allowed)
                finally:
                    keep_awake(False)
                body = {"node_id": node, **({"error": out["error"]} if set(out) == {"error"} else {"result": out})}
                cloud.post(f"/api/gpu/requests/{req['id']}/result", json=body).raise_for_status()
            except httpx.HTTPError as e:
                log.warning("cloud call failed (%s); retrying in %ss", type(e).__name__, backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, 60)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_forever()
