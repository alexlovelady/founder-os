# Windows GPU node setup (RTX 5070 Ti)

Ollama and the agent run natively; no Docker. **Nothing on your PC listens for the internet.** The agent makes only outbound
HTTPS calls to your Railway app: it long-polls for work, runs it on local Ollama, and posts the answer back.

## 1. Ollama
```powershell
ollama pull qwen3:14b
ollama pull qwen3:30b
ollama pull qwen3-embedding:0.6b   # local embeddings (1024-d), used for private and local-only matters
ollama list
```
**Set the context window.** Ollama defaults to a 4096-token context on a 16 GB GPU, which silently truncates long prompts
(research with ten passages, contract review). Set a user environment variable and restart Ollama:
```powershell
setx OLLAMA_CONTEXT_LENGTH 16384
```
Confirm with `ollama ps`: the CONTEXT column should read 16384. Ollama listens on `127.0.0.1:11434`; leave it that way.
Optionally set `OLLAMA_KEEP_ALIVE=10m` so the deep model unloads when idle.

## 2. The pull agent
```powershell
cd C:\legalAI\services\gpu-gateway
py -3.12 -m venv ..\..\.venv ; ..\..\.venv\Scripts\pip install httpx
```
Create `services\gpu-gateway\.env` (never commit it):
```
GATEWAY_TOKEN=<random 32+ chars; identical to GPU_NODE_TOKEN on Railway>
GATEWAY_ALLOWED_MODELS=qwen3:14b,qwen3:30b,qwen3-embedding:0.6b
API_URL=https://<your app>.up.railway.app
NODE_ID=home-5070ti
```
Run `..\..\.venv\Scripts\python pull_agent.py`. It reports health and VRAM every poll, keeps Windows awake only while a request is
running, and refuses any model that is not in `GATEWAY_ALLOWED_MODELS`. On Railway set `GPU_MODE=pull` (the default),
`GPU_NODE_ID` to the same `NODE_ID`, and `GPU_NODE_TOKEN`.

Start it at logon with a Scheduled Task running `start-agent.cmd` (it launches `pull_agent.py`).

If the PC is off, jobs show "Waiting for private GPU node" and run when the agent returns. Nothing is sent to an external model
unless a matter explicitly allows fallback and a budget is set.

## 3. Optional: push mode (inbound gateway + tunnel)
The earlier design had Railway call a gateway on your PC through a tunnel (`GPU_MODE=push`, `GPU_NODE_URL=...`). It still works
(`python -m gateway.main`, bound to 127.0.0.1, behind Cloudflare Tunnel or Tailscale Funnel) but exposes a public hostname.
Prefer pull mode unless you need streaming.

## 4. Verify
* The Settings page shows the GPU online with VRAM figures.
* Stop the agent: status goes offline within two minutes and new jobs wait.
* Nothing should be reachable from outside: there is no port to test.
