# Metering: what is counted, where

Two gaps this closes: AI work done inside LegalAI's own pages was never counted against plan limits, and no tool reported tokens, so the admin Usage page said "not reported".

## What is counted

| Action | Where it is counted | Metric | Enforced |
|---|---|---|---|
| A shell tool uses AI | Shell, `ctx.useQuota("ai_request")` (unchanged) | `aiRequestsPerMonth` | Yes when Stripe is on; recorded only when it is off |
| Research question (`POST /api/research`) | LegalAI calls the shell before queueing | same | same |
| Contract review (`POST /api/contracts/review`) | same, once per review (its sub-steps are not counted again) | same | same |
| Draft (`POST /api/drafts`) | same | same | same |
| Redline suggestion (`POST /api/redlines`) | same | same | same |
| Comparison with `summarize=true` (`POST /api/comparisons`) | same, only when the AI summary is requested | same | same |
| Generic inference from a page (`POST /api/inference`) | same, unless the call came from the shell (see below) | same | same |
| Tokens of a shell tool's AI job | Shell, when the polled job is complete | `ai_tokens` (quantity = prompt + completion, model recorded, cost 0) | No limit, recorded only |

One unit per user action, counted before the job is queued. A refused action (402) queues nothing.

Shell tool AI is not counted twice: the shell already counts the request itself, and its call to `/api/inference` carries `X-Internal-Token`, which tells LegalAI to skip its own count. A browser that sends a wrong or missing token is counted normally.

## How a LegalAI action is counted

1. LegalAI calls `POST <PLAN_QUOTA_URL>` with header `X-Internal-Token` and body `{"userId", "metric": "ai_request", "amount": 1}`, 3-second timeout, no redirects.
2. The shell checks the token in constant time (404 when `INTERNAL_PROVISION_TOKEN` is unset or under 32 characters, 401 when wrong).
3. The shell picks the user's business: their oldest membership. The caller never names a business. A user with no business (a standalone LegalAI user) is allowed and nothing is counted.
4. It runs the same enforcement as tools (`quotaFor`): Stripe off means record and allow; Stripe on means enforce the plan. Over the limit it answers `402 {"allowed": false, "message": "..."}`.
5. LegalAI turns a 402 into `HTTPException(402, message)`. The web UI already shows `detail` strings from non-OK responses (`ApiError` in `modules/legal/web/src/api.ts`), so people see the plan message.

## Fail open

When `PLAN_QUOTA_URL` is empty the check is skipped entirely. On any problem reaching the shell (timeout, connection refused, 5xx, 404, 401, bad answer) LegalAI logs a warning (error type or HTTP status only, never the URL, token or body) and lets the work proceed. A shell outage never blocks legal work. The cost is that usage during an outage is not counted.

## Environment variables

| Variable | Service | Value |
|---|---|---|
| `PLAN_QUOTA_URL` | LegalAI | The shell's private address, for example `http://shell.railway.internal:8080/api/internal/quota/consume`. Empty (default) means LegalAI AI work is not metered. |
| `INTERNAL_PROVISION_TOKEN` | LegalAI and shell | The same secret (32+ characters) on both; also used for signup provisioning. Unset or short on the shell makes the quota route 404 and the admin LegalAI numbers unavailable. |
| `LEGAL_URL` | shell | Already set; used for the admin usage fetch. |

The quota route is a shell route (`/api/internal/quota/consume`), called server to server over the private network and never by browsers. The shell proxy does not forward it to LegalAI; `/legal-ui/api/internal/*` stays blocked.

## Admin Usage page

* Tool AI tokens per model (from `usage_events` metric `ai_tokens`) for the selected range.
* LegalAI-side totals for the last 30 days, platform wide: requests, tokens, cost. Fetched from LegalAI's private `GET /api/internal/usage?all=1&since=...` (token gated, 404 when unset). Per user: `?user_id=...&since=...`. Requests are user-started AI jobs (not pipeline sub-steps); tokens and cost come from `provider_usage`. If LegalAI does not answer, the page says so instead of showing zero.
* Local GPU: no per-token cost. Cost is recorded as 0 and the page says so. A paid fallback model, if one ran, shows its cost in the LegalAI figure.

## Token dedupe

Migration `shell/migrations/0010_metering.sql` adds `usage_events.external_id` and a partial unique index on `(business_id, metric, external_id)`. Token usage is written with `external_id = "job:<job id>"` and `ON CONFLICT DO NOTHING`, so repeated polls of one job record once.

## What is NOT counted

* Anything that is not a person-started AI action: document ingestion, OCR, embeddings, library refreshes, backups, pipeline sub-jobs of a review, redline, draft or research.
* Plain comparisons (no AI summary), saving or downloading a draft, applying revisions, search, reads and polling.
* Tokens of work done inside LegalAI pages are not written to the shell's `usage_events`; they appear only in the LegalAI totals on the admin page.
* Usage during a shell outage (fail open), and usage when `PLAN_QUOTA_URL` is empty.
* Users without a FounderOS business (standalone LegalAI users): allowed, never counted.
* Tokens are not counted against any plan limit; they are for visibility only.
