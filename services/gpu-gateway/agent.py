"""Windows heartbeat agent. Run at logon via Task Scheduler (see README).

Every INTERVAL seconds: asks the local gateway for health, reads GPU VRAM via nvidia-smi, posts a heartbeat
to Railway, and keeps Windows awake only while the gateway has active jobs.
Env: GATEWAY_TOKEN, GATEWAY_PORT (8787), API_URL (https://your-app.up.railway.app), NODE_ID, INTERVAL (30)."""
import ctypes
import json
import logging
import os
import subprocess
import sys
import time

import httpx

sys.path.insert(0, os.path.dirname(__file__))
from gateway.signing import sign  # noqa: E402

ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
TOKEN = os.environ["GATEWAY_TOKEN"]
PORT = os.environ.get("GATEWAY_PORT", "8787")
API_URL = os.environ["API_URL"].rstrip("/")
NODE_ID = os.environ.get("NODE_ID", "home-gpu")
INTERVAL = int(os.environ.get("INTERVAL", "30"))
log = logging.getLogger("agent")


def keep_awake(active: bool) -> None:
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if active else 0))


def gpu_info() -> dict:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,memory.free",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10).stdout
        name, total, free = [x.strip() for x in out.splitlines()[0].split(",")]
        return {"gpu": name, "vram_total_mb": int(total), "vram_free_mb": int(free)}
    except Exception:  # noqa: BLE001
        return {}


def gateway_health() -> dict | None:
    path = "/health"
    try:
        r = httpx.get(f"http://127.0.0.1:{PORT}{path}", timeout=8,
                      headers={"Authorization": f"Bearer {TOKEN}", **sign(TOKEN, "GET", path, b"")})
        return r.json() if r.status_code == 200 else None
    except httpx.HTTPError:
        return None


def tick() -> None:
    h = gateway_health()
    active = (h or {}).get("active_jobs", 0)
    keep_awake(active > 0)
    hb = {"node_id": NODE_ID, "status": "online" if h else "offline", "models": (h or {}).get("models", []),
          "active_jobs": active, **gpu_info()}
    try:
        httpx.post(f"{API_URL}/api/gpu/heartbeat", json=hb, headers={"Authorization": f"Bearer {TOKEN}"},
                   timeout=15).raise_for_status()
    except httpx.HTTPError as e:
        log.warning("heartbeat failed: %s", type(e).__name__)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    while True:
        tick()
        time.sleep(INTERVAL)
