# Windows GPU node setup (RTX 5070 Ti)

Ollama and the gateway run natively; no Docker needed. **Never port-forward 11434 or 8787.**

## 1. Ollama
```powershell
ollama pull qwen3:14b
ollama pull qwen3:30b
ollama pull qwen3-embedding:0.6b   # local embeddings (1024-d), used for private/local-only matters
ollama list
```
**Set the context window.** Ollama defaults to a 4096-token context on a 16 GB GPU, which silently truncates long prompts
(research with ten passages, contract review). Set `OLLAMA_CONTEXT_LENGTH=16384` as a user environment variable and restart Ollama
(`setx OLLAMA_CONTEXT_LENGTH 16384`; confirm with `ollama ps`, the CONTEXT column should read 16384).

Ollama listens on `127.0.0.1:11434` by default — leave it that way. Optionally set `OLLAMA_KEEP_ALIVE=10m` so the deep
model unloads when idle (spec §27).

## 2. Gateway
```powershell
cd C:\legalAI\services\gpu-gateway
py -3.12 -m venv .venv ; .\.venv\Scripts\pip install -r requirements.txt
```
Create `.env` next to it (never commit it):
```
GATEWAY_TOKEN=<random 32+ chars; identical to GPU_NODE_TOKEN on Railway>
GATEWAY_ALLOWED_MODELS=qwen3:14b,qwen3:30b,qwen3-embedding:0.6b
```
Run: `.\.venv\Scripts\python -m gateway.main` (binds `127.0.0.1:8787`).
The gateway refuses to start with a short token and returns 403 for any model not in the allowlist.

## 3. Tunnel (Cloudflare Tunnel, replaceable)
```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create legalai-gpu
cloudflared tunnel route dns legalai-gpu gpu.<your-domain>
```
`config.yml`:
```yaml
tunnel: legalai-gpu
credentials-file: C:\Users\<you>\.cloudflared\<id>.json
ingress:
  - hostname: gpu.<your-domain>
    service: http://127.0.0.1:8787
  - service: http_status:404
```
`cloudflared service install`. Set `GPU_NODE_URL=https://gpu.<your-domain>` on Railway. The gateway's bearer token +
HMAC signature authenticate every call. For a second layer, add a Cloudflare Access service-token policy to the
hostname (not required for the app to work).

## 4. Heartbeat agent
Set env vars `GATEWAY_TOKEN`, `API_URL=https://<railway domain>`, `NODE_ID=home-5070ti` and run
`python agent.py` using the gateway venv. To start at logon, create a Task Scheduler task (trigger: At log on;
action: the venv `python.exe` with argument `C:\legalAI\services\gpu-gateway\agent.py`). Do the same for the gateway
and `cloudflared`. The agent only sends GPU name, VRAM, model names and active job count.

## 5. Verify
- Railway app → `GET /api/gpu/status` shows `online: true`.
- Stop the gateway: status goes offline within ~2 minutes; submitted jobs show `Waiting for private GPU node`
  and complete after you restart it.
- Confirm from another network that `http://<your-public-ip>:11434` is unreachable.
