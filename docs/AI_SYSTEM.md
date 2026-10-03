# AI system

How AI works in FounderOS today, written from the code (read 2026-10-03). Anything not listed under "What exists" should be assumed not to exist. Spec reference: build spec sections 10-12 (Founder AI, context, tool calling), 36 (AI cost control), 42 (AI safety).

## In one paragraph
Tools never call a model directly. A tool asks `ctx.ai` for a **tier** (`fast` or `deep`). The shell turns that into a job on the LegalAI service's job queue. LegalAI's embedded worker hands the job to the **private GPU node** over a pull connection: the owner's Windows PC makes outbound HTTPS calls only, runs the request on local Ollama, and posts the answer back. The shell polls the job until it is done. There is no third-party AI provider in the default configuration, and nothing is used to train a model.

## End to end

```
Tool code (modules/*)                     ctx.ai.start({ tier, system, prompt })
        |
shell/src/lib/tools/ai.ts                 POST {LEGAL_URL}/api/inference   (as the signed-in user: session cookie + CSRF token)
        |                                  body: { matter_id: <business LegalAI workspace>, messages, role: tier, task: "tool" }
LegalAI routers/jobs.py                    needs "editor" access to that workspace; enqueues job type llm_complete, requires_gpu = true
        |
LegalAI worker (jobs/runner.py)           claims the job; if the GPU node is online -> runs it; otherwise WAITING_FOR_GPU (see below)
        |
providers/pull_gpu.py                     writes a request row (gpu_requests); waits for the node to claim and answer; deletes the row once read
        |
services/gpu-gateway/pull_agent.py        (owner's PC) POST /api/gpu/claim (long poll, doubles as heartbeat) -> local Ollama -> POST result
        |
Ollama on 127.0.0.1:11434                 model named by the role mapping below
```

Polling: `ctx.ai.poll(jobId)` calls `GET /api/jobs/<id>`. The shell maps LegalAI job states like this: `COMPLETE` becomes `done` (text taken from `result.content`, with any `<think>...</think>` block removed); `FAILED` or `CANCELED` becomes `failed` with the job's error; `WAITING_FOR_GPU` becomes `waiting` with the message "Your private AI computer is offline. This will finish when it is back on."; everything else is `running`. A malformed job id is rejected before any request is made.

`ctx.ai.available` is true only when the business has a LegalAI workspace id (`business.modules.legal.workspaceId`). Without it, `start()` throws "AI is not set up for this business yet" and tools show their non-AI path. The workspace is created by `provisionLegal` (`shell/src/lib/legal.ts`) when the business is created, and re-linked from the dashboard if LegalAI was unreachable at the time.

Replacing the provider is meant to be a one-file change: `shell/src/lib/tools/ai.ts` is the only place the shell knows about LegalAI inference.

## Model roles (fast and deep)
LegalAI maps a role to an Ollama model name from environment variables (`Settings.model_for_role` in `modules/legal/api/legalai/config.py`):

| Role | Env var | Used for | Value in `.env.example` and docs/railway.md |
|---|---|---|---|
| `fast` | `FAST_MODEL` | short, structured work: classification, summaries, discovery suggestions | `qwen3:14b` |
| `deep` | `DEEP_MODEL` | long reasoning: contract assessment, research answers, analyses, the assistant | `qwen3:30b` |
| `critic` | `CRITIC_MODEL` (falls back to `FAST_MODEL`) | LegalAI's second-pass critic | `qwen3:14b` |
| `extraction` | `EXTRACTION_MODEL` (falls back to `FAST_MODEL`) | clause extraction in contract review | `qwen3:14b` |

Tools in the shell can only ask for `fast` or `deep` (`AiRequest.tier` in `modules/sdk/src/index.ts`; default `fast`). `critic` and `extraction` are used by LegalAI's own pipelines. A role with no configured model raises "No model configured for role ...". The model names above are what the repository documents; what is actually set on the live Railway service was not checked.

When a request says `role: "auto"` LegalAI maps the `task` to a role (`AUTO_ROLE` in `jobs/queue.py`: extraction, classification and query rewrite use `fast`; contract review, research and drafting use `deep`; unknown tasks use `deep`).

## Which tools use AI, and how
All of these are asynchronous (start, then poll), all label output as AI output, none call AI from `facts`, `describe`, `attention` or `search`.

| Tool | Tier | What it asks the model | Notes |
|---|---|---|---|
| Ask FounderOS (`founderai`) | deep | Answer a question from `ctx.context()`, top attention items and numbered sources | Prompt capped at 6000 characters; 30 minute timeout; citations checked for existence; unmatched numbers and dates produce a warning; may PROPOSE actions that a person confirms (never runs them). Counts `ai_request` against the plan. |
| Document Vault (`vault`) | fast | Summarize the first 6000 characters of a document | Text is marked untrusted data in the prompt. Counts `ai_request`. |
| LegalAI review hand-off (`shell/src/lib/legalbridge`) | (LegalAI's own pipeline) | Uploads the vault file to LegalAI and starts a contract review | Counts `ai_request`. See LEGAL_AI.md. |
| Marketing (`marketing`) | fast or deep, chosen per kind of draft | Draft copy from the saved brand voice plus business context | Server-side claim check flags invented numbers, testimonials, guarantees. Counts `ai_request`. |
| Competitors (`competitors`) | deep (analysis, report), fast (discovery) | Analyse fetched public pages; build a comparison; suggest names | Model JSON is checked in code: source URLs must be pages that were fetched, quotes must appear on the page, pricing claims without a verified quote are discarded. |
| Product Scan (`product`) | deep | Synthesise what a repository is from the deterministic scan result | Labelled as AI and as suggestions for a professional. |
| SOPs (`sops`) | deep to draft or expand, fast to polish | Draft, improve or expand an SOP | The SOP builder itself needs no AI. Counts `ai_request`. |

LegalAI's own pages (review, research, drafting, revision) run their own multi-step pipelines on the same queue and the same GPU. They are described in docs/LEGAL_AI.md.

## Privacy modes and fallback
Every LegalAI "matter" (shown as a project or workspace) has a privacy mode, enforced in the backend (`modules/legal/api/legalai/privacy.py`), never in the browser:

| Mode | Meaning |
|---|---|
| `standard` | External embeddings allowed when a provider is configured. |
| `private` (default, `DEFAULT_PRIVACY_MODE`) | External embeddings only if the matter explicitly enabled them. |
| `local_only` | Never any external service. External fallback and external embeddings cannot be enabled (validation rejects it) and are forced off even if a row is tampered with. |

The business's company workspace is created with `DEFAULT_PRIVACY_MODE` (`private` unless overridden).

**Embeddings** use the external Voyage model only when `EMBEDDING_PROVIDER=external`, a key is set and the matter's mode permits it; otherwise they are computed locally on the GPU (`qwen3-embedding:0.6b`, 1024-dimensional).

**External LLM fallback** is off in the documented configuration (`LLM_FALLBACK_PROVIDER=disabled`, `EXTERNAL_LLM_MONTHLY_BUDGET_USD=0`). It can only run when all of these hold (`decide_fallback`): a fallback provider and base URL are configured; the matter's fallback mode is not `disabled` (and the matter is not `local_only`); the monthly budget is above $0 and not spent; and, for mode `ask`, the matter owner approved that job (`POST /api/jobs/<id>/approve-fallback`). Otherwise the job waits for the GPU. Local embedding jobs never have an external substitute. Use of the fallback is written to the audit log. No tool in the shell can switch it on.

## When the GPU is off
* The node reports a heartbeat on every poll. LegalAI treats it as online if the last heartbeat is newer than `GPU_HEARTBEAT_STALE_S` (120 s).
* If the node is offline the job goes to `WAITING_FOR_GPU` ("Waiting for private GPU node") and is retried every `GPU_RETRY_INTERVAL_S` (30 s). It starts by itself when the PC comes back. Nothing is lost, and nothing goes elsewhere.
* A request the node does not claim within `GPU_CLAIM_TIMEOUT_S` (90 s) or finish within `GPU_REQUEST_TIMEOUT_S` (600 s) is treated as unavailable and the job goes back to waiting (an outage does not count as an attempt). Other errors retry with back-off, up to 5 attempts, then the job is `FAILED`.
* Prompts and answers sit in the `gpu_requests` table only until the worker has read them; the row is deleted then, and abandoned rows are removed. They are not written to logs.
* The pull agent refuses any model that is not in its `GATEWAY_ALLOWED_MODELS` list and passes only these parameters to Ollama: `temperature`, `top_p`, `max_tokens`, `stop`, `seed`, `response_format`. It keeps Windows awake only while a request is running. Setup is in docs/gpu-node-windows.md.
* Push mode (Railway calls a gateway through a tunnel) still exists (`GPU_MODE=push`) but is not the documented setup.

## Quotas and limits
* **Plan limit:** `aiRequestsPerMonth` in `shell/src/config/plans.ts` (Free 20, Founder 300, Pro 1500, Business unlimited). `useQuota` counts usage events in the current UTC month under a per-business advisory lock and throws HTTP 402 with a plain message at the limit (docs/BILLING.md).
* **While Stripe is not configured**, `billingActive()` is false, every business gets the Business plan limits, and nothing is blocked (`shell/src/lib/tools/plan.ts`); usage under the `ai_request` name is still recorded. As read on 2026-10-03 every shell AI entry point calls `ctx.useQuota("ai_request")` before starting the job: the assistant, marketing, SOPs, competitors (analysis, report, discovery), product scan, the vault summary and the LegalAI review hand-off. Quota wiring was being changed by other work while this was written; re-check each tool's `useQuota` calls.
* **Not counted by the shell at all:** AI work done inside LegalAI's own pages (review, research, drafting), because those run in LegalAI and never pass through `ctx.useQuota`. I found no code that meters them against the plan.
* **Tokens and cost are not metered per request.** `recordUsage` accepts `model` and `estimatedCostUsd`, but no tool reports them. LegalAI records prompt and completion tokens per job in its own `provider_usage` table.
* **Speed.** The GPU is a single consumer card (documented as an RTX 5070 Ti, 16 GB). The embedded worker loop processes one job at a time, so queued jobs wait behind each other; the deep model is a 30B-parameter model, and the first request after idle loads it into memory. Expect seconds for short answers and minutes for a careful contract review or analysis. Every UI that starts AI polls and shows progress.
* **Context window.** Ollama defaults to 4096 tokens on this GPU class and silently truncates; docs/gpu-node-windows.md says to set `OLLAMA_CONTEXT_LENGTH=16384`. That is a setting on the owner's PC; the code cannot verify it. Tools also keep their own prompts short (for example 6000 characters for the assistant and the vault summary).
* **Concurrency.** The shell has no AI rate limiter of its own beyond plan quotas. LegalAI rate-limits its heavy routes (60 per minute per IP, in memory) and applies request size caps.

## Honesty rules (from docs/TOOLS.md, enforced in different ways)
* AI output is never presented as fact. Where output contains claims the code can check, the code checks them (quotes, citations, source URLs, numbers); what cannot be checked is labelled.
* Models cannot take actions. The assistant can only propose, a person confirms, and a proposal is validated against the tool's own schema and business scope first.
* Documents and fetched pages are treated as untrusted data in prompts (delimited, with a system instruction not to follow them), and outputs are validated in code regardless.

## What is not built
* **Cloud and bring-your-own-key AI tiers.** `aiTier` in `plans.ts` has the values `local`, `cloud` and `bring_your_own`, but every plan is `local` and no cloud or customer-key client exists. The owner deferred these.
* Per-request token and cost metering in the shell, and a per-model usage report.
* Streaming answers (the GPU path returns whole answers; the UI polls).
* A queue priority, a per-business concurrency cap, or a way to run more than one GPU node.
* Fine-tuned models. They are deliberately not planned: answers come from retrieved text plus code-side verification (docs/LEGAL_AI.md; `modules/legal/docs/legal-sources.md`).

## Where to look
| What | Where |
|---|---|
| Shell AI client | `shell/src/lib/tools/ai.ts`, contract in `modules/sdk/src/index.ts` |
| Plan and quota wiring | `shell/src/lib/tools/plan.ts`, `shell/src/lib/billing/` |
| Job queue, states, retry | `modules/legal/api/legalai/jobs/` |
| GPU provider (pull) | `modules/legal/api/legalai/providers/pull_gpu.py`, `routers/gpu.py` |
| Privacy and fallback rules | `modules/legal/api/legalai/privacy.py` |
| GPU agent and setup | `services/gpu-gateway/pull_agent.py`, `docs/gpu-node-windows.md` |
| Public statement | `/ai-disclosure` (a draft, pending review by a lawyer) |
