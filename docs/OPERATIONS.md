# Operations runbook

Written from the code on 2026-10-03. It says what the repository can show. Anything about the live Railway project that the repository cannot show is marked **not verified**: check it in the dashboard. For the first-time setup of an empty project read docs/DEPLOYMENT.md; this file is for running the product afterwards. Security status is in docs/SECURITY.md.

Contents: [Services](#services) · [Deploys](#deploys) · [Environment variables](#environment-variables) · [Migrations](#migrations) · [Scheduler](#scheduler) · [Backups and restore](#backups-and-restore) · [Monitoring](#monitoring-errors-and-logs) · [Request gate: rate limits and CSRF](#request-gate-rate-limits-and-same-site-check) · [Rotating secrets](#rotating-secrets) · [Resetting a stuck LegalAI job queue](#resetting-a-stuck-legalai-job-queue) · [Health checks](#health-checks) · [Demo data](#demo-data) · [Quick reference](#quick-reference)

## Services
| Service | What | Health |
|---|---|---|
| `shell` | Next.js app: site, sign-in, dashboard, every tool, `/admin`, proxy to LegalAI under `/legal-ui`, in-process scheduler | `GET /healthz` returns `{"ok":true}` (does not touch the database) |
| `api` | LegalAI (FastAPI) with the embedded job worker | `GET /healthz`; admins also get `GET /api/admin/health` (database, storage, worker tick, GPU heartbeat, backup freshness, queue age) |
| `Postgres` | The shell's database | `pg_isready`; Railway shows status |
| `postgres` (pgvector) | LegalAI's database | same |
| GPU PC | Runs Ollama and the pull agent; makes outbound calls only | LegalAI Settings page shows it online; `/api/gpu/status` |

## Deploys
Full commands and rollback are in docs/DEPLOYMENT.md. The short version, from the repository root with the Railway CLI linked:
```
railway up -s api -c      # LegalAI first
railway up -s shell -c    # then the shell (it calls the API)
```
Before a release, locally:
1. `npx vitest run` (needs the `founderos_test` database), `cd shell && npx tsc --noEmit && npm run lint`, `npm run build --workspace shell`.
2. Optional: `cd e2e && npm test` against a local stack (docs/E2E.md).
3. If the release adds a migration, read [Migrations](#migrations): it runs at container start and cannot be undone by a rollback.

After the deploy: open `/healthz` on both services, sign in, open the dashboard, and run the [health checks](#health-checks). The shell container runs `node shell/scripts/migrate.mjs && node shell/server.js`; if migrations fail the container exits and Railway keeps the previous deployment serving only if the restart policy and health check say so (**not verified**: confirm in the dashboard that a failed deploy does not take the old one down).

Things that need a rebuild, not just a restart: `LEGAL_URL` (build argument, baked into the rewrites) and any `NEXT_PUBLIC_*` variable.

## Environment variables
Every variable the code reads. "Needed" means the feature is off or the service will not start without it. Narrative for the common ones is in docs/DEPLOYMENT.md.

### `shell` (Next.js; `shell/src`, `modules/*/src`, `shell/scripts`)
| Variable | Needed | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string for the shell database (`postgresql://...`). Read by the server, `scripts/migrate.mjs`, the scheduler, and the backup and demo scripts. |
| `LEGAL_URL` | yes | Address of LegalAI. Build argument for the `/legal-ui` rewrites and also read at runtime. Default `http://localhost:8000`. |
| `PORT`, `HOSTNAME` | Railway sets `PORT` | Standard Next.js standalone server variables. The Dockerfile sets `HOSTNAME=0.0.0.0`. |
| `NODE_ENV` | set by the image | `production` turns on HSTS and secure cookies in places. |
| `APP_URL` | recommended | Public base URL for links in emails and Stripe return URLs. |
| `NEXT_PUBLIC_APP_URL` | recommended | Base URL for sitemap and canonical links. Build time. Falls back to `https://$RAILWAY_PUBLIC_DOMAIN`. |
| `NEXT_PUBLIC_CONTACT_EMAIL` | optional | Shown on `/contact` and `/security`. Build time. |
| `RAILWAY_PUBLIC_DOMAIN` | set by Railway | Fallback for the public URL. |
| `TRUST_PROXY` | optional | `true` makes the request gate believe `X-Forwarded-For`. Implied on Railway (see below). Also read by the proxy through `RAILWAY`, `RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, which Railway sets itself. |
| `STRIPE_SECRET_KEY` | optional | Turns billing and plan limits on. |
| `STRIPE_WEBHOOK_SECRET` | with Stripe | Verifies `/api/billing/webhook` signatures. |
| `STRIPE_PRICE_FOUNDER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` | with Stripe | Price ids that map to our plans. |
| `STRIPE_TRIAL_DAYS` | optional | Trial length, default 0. |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional, both or neither | Email sending (reminders, weekly brief, invites). |
| `SEARCH_API_KEY` | optional | Brave Search for competitor discovery. |
| `FOUNDEROS_SECRET_KEY` | optional | 32 random bytes, base64. Encrypts saved repository tokens (Product Scan). |
| `INTERNAL_PROVISION_TOKEN` | for signup | Shared secret (32+ characters), identical on `shell` and `api`. |
| `SIGNUP_MODE` | optional | `closed` (default), `invite`, `open`. |
| `SIGNUP_HASH_SECRET` | optional | Key for signup attempt hashes. Falls back to the token. |
| `SIGNUP_TRUSTED_PROXY_HOPS` | optional | Proxies in front of the shell for signup rate limits (default 1). |
| `SCHEDULER_DISABLED` | optional | `1` turns the in-process scheduler off (for example on a second instance). |
| `SCHEDULER_TICK_MS` | optional | Scheduler tick, default 10 minutes. |
| `NEXT_RUNTIME`, `NEXT_PHASE` | set by Next.js | Used to keep migrations and the scheduler out of `next build`. Do not set them. |
| `RAILWAY_DOCKERFILE_PATH` | yes on Railway | `shell/Dockerfile`. |

### Operations (read by the running shell)
| Variable | Default | What it does |
|---|---|---|
| `BACKUP_DIR` | unset = backups off | Folder for the scheduled verified dumps; on Railway `/data/backups` on a volume mounted at `/data`. docs/BACKUPS.md. |
| `BACKUP_KEEP` | 7 | Dumps kept in `BACKUP_DIR`. |
| `BACKUP_VERIFY_RESTORE` | off | `1` = also restore each dump into a scratch database and compare row counts. |
| `BACKUP_PULL_TOKEN` | unset = pull endpoints 404 | 32+ characters; lets the owner's PC download the latest verified dump (`X-Internal-Token`). Separate from `INTERNAL_PROVISION_TOKEN`. |
| `SENTRY_DSN` | unset | Optional: also forward sanitized server errors to Sentry (no SDK; one envelope POST). |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |

### Scripts and tests (not read by the running server)
| Variable | Used by | What it does |
|---|---|---|
| `BACKUP_DIR` | `backup-shell.mjs`, `restore-check.mjs` | Default backup folder (`backups/shell`). (The server reads the same name for the scheduled job, see above.) |
| `BACKUP_KEEP` | `backup-shell.mjs` | How many dumps to keep (default 14; the server's scheduled job defaults to 7). |
| `BACKUP_DOCKER` | both | Container name to run `pg_dump` / `pg_restore` in (for a PC with Postgres in Docker and no client). |
| `PG_DUMP`, `PG_RESTORE` | both | Full paths to the client tools when they are not on `PATH`. |
| `TEST_DATABASE_URL` | vitest (`@founderos/sdk/testing`) | Defaults to `postgresql://legalai:legalai-dev@localhost:5442/founderos_test`. |
| `E2E_BASE_URL`, `E2E_EMAIL`, `E2E_PASSWORD` | `e2e/` | Which stack to test and the LegalAI test account to sign in with. See docs/E2E.md. |

### `api` (LegalAI; `modules/legal/api/legalai/config.py`, pydantic settings; each field is read from the upper-case environment variable of the same name, or from `.env`)
| Variable | Default | What it does |
|---|---|---|
| `APP_ENV` | `local` | Set `production` in production. |
| `APP_BASE_URL` | `http://localhost:8000` | Public base URL. |
| `EMBED_ORIGINS` | empty | Extra origins allowed to frame LegalAI. Not needed while the shell proxies it. |
| `DATABASE_URL` | local dev | **With the driver prefix** `postgresql+psycopg://...`. |
| `SESSION_SECRET` | empty | Signs sessions; derives the key that encrypts authenticator secrets. Must be set in production. |
| `COOKIE_SECURE` | `false` | `true` in production. |
| `SESSION_TTL_HOURS` | `168` | Session lifetime. |
| `TRUST_PROXY` | `false` | `true` behind Railway so client IPs for its own rate limits are right. |
| `INTERNAL_PROVISION_TOKEN` | empty | Same value as on the shell; empty disables `/api/internal/*`. |
| `RUN_WORKER` | `true` | Run the job worker inside the API process. |
| `STORAGE_DIR` | `./data/storage` | Document files. On Railway a volume mounted at `/data`, value `/data/storage`. |
| `MAX_UPLOAD_MB` | `50` | Upload cap. |
| `BACKUP_ENABLED`, `BACKUP_DIR`, `BACKUP_INTERVAL_HOURS`, `BACKUP_INCLUDE_STORAGE`, `BACKUP_VERIFY`, `BACKUP_TOKEN` | off, volume, 24, false, true, empty | Scheduled backups and the off-site puller's token (modules/legal/docs/backup.md). |
| `OCR_ENABLED`, `OCR_LANG`, `OCR_DPI`, `OCR_MAX_PAGES`, `TESSERACT_CMD` | true, eng, 200, 150, empty | OCR. |
| `COURTLISTENER_TOKEN` | empty | Case-law library refresh. |
| `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_REQUIRED` | empty, 3310, false | Optional virus scanning service. |
| `VECTOR_STORE` | `pgvector` | Vector store. |
| `LLM_PRIMARY_PROVIDER`, `LLM_FALLBACK_PROVIDER`, `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_API_KEY`, `LLM_FALLBACK_MODEL` | `local_gpu`, `disabled`, empty | Provider routing. Keep the fallback `disabled` unless you opt in. |
| `EXTERNAL_LLM_MONTHLY_BUDGET_USD`, `EXTERNAL_LLM_PRICE_PER_1K_TOKENS_USD` | `0` | Spending cap and price for the fallback. |
| `GPU_MODE`, `GPU_CLAIM_TIMEOUT_S`, `GPU_NODE_URL`, `GPU_NODE_TOKEN`, `GPU_NODE_ID`, `GPU_REQUEST_TIMEOUT_S`, `GPU_RETRY_INTERVAL_S`, `GPU_HEARTBEAT_STALE_S` | `pull`, 90, empty, empty, `home-gpu`, 600, 30, 120 | The home GPU link. `GPU_NODE_TOKEN` equals `GATEWAY_TOKEN` on the PC. |
| `FAST_MODEL`, `DEEP_MODEL`, `CRITIC_MODEL`, `EXTRACTION_MODEL` | empty | Model names per role; a role with no model raises an error when used. |
| `EMBEDDING_PROVIDER`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_MONTHLY_BUDGET_USD`, `LOCAL_EMBEDDING_MODEL`, `VOYAGE_BASE_URL`, `EMBEDDING_PRICE_PER_1M_TOKENS_USD`, `EMBEDDING_BATCH_SIZE` | `external`, empty, `voyage-law-2`, none, `qwen3-embedding:0.6b`, Voyage URL, 0.12, 32 | Embeddings. `EMBEDDING_PROVIDER=local` forbids external embeddings. |
| `W_SEMANTIC`, `W_SEMANTIC_EXACT`, `W_LEXICAL`, `RRF_K`, `MAX_CHUNKS_PER_DOCUMENT`, `AUTHORITY_SCALE`, `CURRENTNESS_DAYS` | 10, 1.5, 1, 60, 3, 1, 30 | Retrieval tuning. Leave alone. |
| `DEFAULT_PRIVACY_MODE` | `private` | Default for new matters. |
| `RAILWAY_DOCKERFILE_PATH` | | `modules/legal/api/Dockerfile`. |

### GPU PC (`services/gpu-gateway/.env`)
`GATEWAY_TOKEN`, `API_URL`, `NODE_ID`, `GATEWAY_ALLOWED_MODELS`, and `OLLAMA_CONTEXT_LENGTH` for Ollama. See docs/gpu-node-windows.md.

## Migrations
Two mechanisms, both automatic and forward-only (docs/DATABASE.md):
* **Shell SQL** `shell/migrations/NNNN_name.sql`: `shell/scripts/migrate.mjs` runs each file once, in a transaction, at container start, and records it in `schema_migrations`. Files must be re-runnable (`IF NOT EXISTS`), because the test harness replays them. The lead assigns numbers so two changes never collide.
* **Tool tables** `tool.migrations` in each module: applied by `instrumentation.ts` at server start under an advisory lock and recorded in `tool_migrations (tool, name)`.
* **LegalAI** uses Alembic: `alembic upgrade head` is part of its start command. `alembic downgrade -1` exists but is untested.

Run by hand locally: `cd shell && DATABASE_URL=... node scripts/migrate.mjs`. A rollback of the code does not undo a migration; to undo data changes restore a verified backup into a **new** database and point `DATABASE_URL` at it. To see what has run: `SELECT * FROM schema_migrations ORDER BY name;` and `SELECT * FROM tool_migrations ORDER BY tool, name;`.

## Scheduler
The shell starts a scheduler in-process (`startScheduler()` from `instrumentation.ts`). Every `SCHEDULER_TICK_MS` (10 minutes) it runs the due jobs under a Postgres advisory lock, so only one instance does the work, and records each run in `scheduled_runs(job, ran_at, ok, detail)`. Jobs: notification outbox, daily reminders, weekly brief, system automations (docs/NOTIFICATIONS.md), and two operations jobs registered from `instrumentation.ts`: `shell_backup` (daily, verified database dump, docs/BACKUPS.md) and `error_purge` (daily, deletes error groups not seen for 90 days).
* Check it: `SELECT job, max(ran_at) AS last, bool_and(ok) FROM scheduled_runs GROUP BY job;` Each job should have a recent run.
* Stop it: set `SCHEDULER_DISABLED=1` and restart. It never runs during `next build`.
* With several shell instances only one runs a given job per tick (advisory lock), so it is safe; if you want one instance to carry no scheduler, set `SCHEDULER_DISABLED=1` on the others.
* Email is off until `RESEND_API_KEY` and `EMAIL_FROM` exist; nothing is queued without a provider.

## Backups and restore
Status: **the shell backs up its own database daily** to a volume once `BACKUP_DIR` is set, verifies each dump, and serves it to a token-gated pull script that runs on the owner's PC. The exact owner steps, what is and is not verified, the restore procedure and the restore drill are in **docs/BACKUPS.md**. Until the volume and `BACKUP_DIR` exist, **there is no backup**: /admin/backups shows a red banner saying so (and when the newest verified backup is older than 36 hours). Whether Railway also backs up the `Postgres` service is **not verified**.

### Railway
In the Railway dashboard open the `Postgres` service and look for its **Backups** tab. Railway offers volume backups for database services on some plans and lets you set a schedule; confirm in your own dashboard that the tab exists for your plan, which schedule is on, how long copies are kept, and do one restore test into a new service. Do the same for the pgvector `postgres` service. Do not treat either as backed up until you have done that. Volume backups live inside Railway, so they do not protect you from losing the Railway account or project: keep an off-platform copy as well (next section).

### Off-platform copy with `backup-shell.mjs`
`shell/scripts/backup-shell.mjs` does what LegalAI's `scripts/backup.py` does, for the shell database: a compressed (`pg_dump -Fc`) dump to a timestamped file, then proof that it is usable.
```
DATABASE_URL=postgresql://... node shell/scripts/backup-shell.mjs --out backups/shell --keep 14 --verify-restore
node shell/scripts/restore-check.mjs backups/shell
```
What it does:
1. Counts the rows of every table, runs `pg_dump`, counts again, writes `shell-YYYYMMDD-HHMMSS.dump` and `shell-....dump.json` (sha256, size, row counts, which tool ran it).
2. `pg_restore --list` on the file (the archive is readable end to end).
3. With `--verify-restore`: creates a scratch database on the **same server**, restores into it, compares every table's row count with the source (a live table may change while it is dumped, so the check accepts a count between the before and after numbers), and drops the scratch database. A dump that fails this is renamed `*.FAILED` and kept out of the rotation, so a bad dump never pushes good ones out.
4. Keeps the newest `--keep` dumps. Exit code 0 only when every step passed; the password is never printed.

`restore-check.mjs` takes a dump or a directory (newest dump) and repeats the proof later: sha256 against the manifest, `--list`, restore into a scratch database, row counts against the manifest, and failure if the newest backup is older than `--max-age-hours` (default 36), which is how you notice that the schedule stopped.

**Needs `postgresql-client`** (`pg_dump` and `pg_restore`, version at least that of the server) on the machine that runs it, or `--docker <container>` / `BACKUP_DOCKER` to run them inside a Postgres container. The shell Docker image now installs PGDG `postgresql-client-16` (same recipe as the LegalAI image) for the scheduled job; **that image change has not been built or deployed yet**, and if the Railway Postgres is newer than 16 the major version in `shell/Dockerfile` must be raised to match.

### Running it
* **From the owner's PC** (recommended: it puts a copy outside Railway). Install the PostgreSQL client tools, take the database's public connection string from the Railway `Postgres` service (the TCP proxy address; keep it out of git and shell history), and schedule a daily task:
  ```powershell
  $env:DATABASE_URL = "<public connection string>"
  node C:\legalAI\shell\scripts\backup-shell.mjs --out D:\founderos-backups --keep 14 --verify-restore
  ```
  The scratch restore needs a server where your user may `CREATE DATABASE`; on Railway that is normally true for the default user, but if it is not, run the restore check against a local Postgres instead (`restore-check.mjs` with `DATABASE_URL` pointing at the local server).
* **From a scheduled job elsewhere** (a Railway cron service, GitHub Actions on a schedule): the job needs `postgresql-client` and somewhere off Railway to put the file; the script only writes to a folder, copying it to storage is up to the job.
* **Local development with Postgres in Docker** (what was done to test it here: no client on the host):
  `DATABASE_URL=postgresql://legalai:legalai-dev@localhost:5442/founderos node shell/scripts/backup-shell.mjs --out backups/shell --verify-restore --docker legalai-db-1`.
  It ran against the local `founderos` database: 55 tables, `pg_restore --list` read 321 entries, the scratch restore matched every row count, the scratch database was dropped. A tampered file was caught by the sha256 check.

### LegalAI database and documents
Handled by LegalAI itself: `BACKUP_ENABLED=true` writes a daily verified dump (7 daily, 4 weekly) under `/data/backups`, and `scripts/pull_backup.py` on the PC copies it off-site (modules/legal/docs/backup.md). Those backups sit on the same volume as the data, so the pull matters.

### Restoring
1. Create a new empty database (a new Railway Postgres service, or a local one).
2. `pg_restore --no-owner --no-privileges -d <new database url> shell-....dump`.
3. Point `DATABASE_URL` at it and redeploy. Row counts per table are in the manifest if you want to check.
4. Practice this once before you need it.

## Monitoring: errors and logs
* **Errors (spec 47).** The shell records its own server errors, with no third-party service: `onRequestError` in `shell/src/instrumentation.ts` (pages, route handlers, server actions) and the scheduler's job wrapper write to `error_events`, grouped by a fingerprint of route + message + first stack frame with a count, first and last seen. Message and stack are scrubbed of tokens, keys, cookies, emails and query strings; the route has no query string; no user, business, header or body data is stored. Look at **/admin/errors** (open/resolved filter, mark resolved; a resolved error that happens again reopens). Groups not seen for 90 days are purged by the `error_purge` job. **Not captured:** errors in the browser, errors the code catches and handles itself, process crashes and out-of-memory kills (Railway logs and restarts show those). There is no client-side beacon.
* **Sentry (optional).** Set `SENTRY_DSN` on `shell` and each captured error is also POSTed, sanitized, to Sentry's envelope endpoint (no SDK; a failure to reach Sentry is ignored). Server side only. Without the DSN nothing leaves the system.
* **Logs (spec 48).** The scheduler and the backup job write one JSON object per line to stdout (`ts`, `level`, `event`, then allow-listed fields such as `job`, `ok`, `detail`, `file`); fields outside the list are dropped, secret-looking keys are redacted and values are scrubbed (`shell/src/lib/ops/log.ts`). In Railway's log search filter on `@event:scheduled_job_failed` or `@level:error`. Older `console.log` lines elsewhere in the app are not yet structured.

## Request gate: rate limits and same-site check
`shell/src/proxy.ts` (Next.js 16 `proxy`, formerly `middleware`) runs before routes and before the `/legal-ui` rewrites. It does two things for requests it matches (`/api/*` and the two LegalAI sign-in endpoints). Pages and static assets never pass through it. Allowed requests are handed on untouched (`NextResponse.next()`), so responses, including streamed ones, are not buffered; only the request body is (see the upload note below). The code is in `shell/src/lib/ratelimit/` (`limiter.ts`, `classify.ts`).

**Same-site (CSRF) check.** A state-changing request (not GET, HEAD or OPTIONS) to `/api/*` is refused with 403 when its `Origin` header is present and its host differs from the `Host` header (or `X-Forwarded-Host` behind a trusted proxy). A request with no `Origin` is allowed only when it carries no `Cookie` header (scripts and curl without a session). `/api/billing/webhook` is exempt: Stripe sends no Origin and is authenticated by its signature.

**Rate limits**, per client, per minute, sliding window:
| What | Limit |
|---|---|
| any `/api/*` request | 600 |
| `/api/*` with POST, PUT, PATCH, DELETE | 60 |
| `/legal-ui/api/auth/login` and `/legal-ui/api/auth/login/mfa` (one shared counter) | 10 |
| `/api/feedback`, `/api/events` (each) | 30 |
| `POST /api/tools/vault/documents` and `.../documents/<id>/versions` (uploads) | 30 |
| `/api/billing/webhook` | not limited |
A request must pass every limit that applies to it (a feedback post counts against 30, 60 and 600). A refused request returns 429 with `{"error": ...}` and a `Retry-After` header and is not counted, so a blocked client recovers as the window slides.

**Which client.** Next.js 16 does not give the proxy the socket address. The key is the first hop of `X-Forwarded-For` (then `X-Real-IP`) only when `TRUST_PROXY` is true or Railway's own variables are present; otherwise every request shares one key, `unknown`, and all limits are multiplied by 10 for it. Behind Railway's edge proxy the first hop is the connecting client, but if you put your own proxy or CDN in front, check that it overwrites rather than appends to `X-Forwarded-For`, or a client can pick its own key.

**Per instance.** The counters are in memory (at most 20,000 keys; idle keys are swept, then the least recently used are dropped). Each shell instance counts separately, and a restart resets them. With N instances the effective limit is up to N times higher. For several instances replace `SlidingWindowLimiter` with a shared store (Redis or a Postgres table) behind the same `consume(client, rules)` call in `proxy.ts`; the classification and the Origin check do not change.

**Uploads and the body buffer.** When a proxy is present Next.js clones and buffers each matched request's body, up to 10 MB by default; beyond that it silently passes only the first 10 MB on (it logs `Request body exceeded 10MB`). The vault accepts files up to 15 MB, so `shell/next.config.ts` needs `experimental: { proxyClientMaxBodySize: "16mb" }`. Without it, uploads between 10 and 15 MB would be truncated. If you ever see that log line, that setting is missing.

## Rotating secrets
General rule: change the value in Railway, redeploy the services that read it (variables are read at start; `LEGAL_URL` and `NEXT_PUBLIC_*` need a rebuild), then check sign-in and the feature the secret protects.
| Secret | Where | Effect and order |
|---|---|---|
| `SESSION_SECRET` (LegalAI) | `api` | Signs everyone out, and authenticator secrets, which are encrypted with a key derived from it, stop working: users with two-step sign-in would be locked out until an admin runs the MFA reset (`POST /api/admin/users/<id>/mfa-reset`). Plan it as a maintenance event. |
| `INTERNAL_PROVISION_TOKEN` | `shell` and `api`, **same value** | Change both, redeploy both. Signup answers 503 between the two. |
| `SIGNUP_HASH_SECRET` | `shell` | Only resets the signup rate-limit windows. |
| `STRIPE_SECRET_KEY` | `shell` | Create a new restricted key in Stripe, set it, redeploy, then delete the old key. |
| `STRIPE_WEBHOOK_SECRET` | `shell` | Roll the signing secret in Stripe (it can keep the old one valid for a while), set the new one, redeploy. |
| `RESEND_API_KEY` | `shell` | New key in Resend, set, redeploy, delete the old one. |
| `SEARCH_API_KEY`, `COURTLISTENER_TOKEN`, `EMBEDDING_API_KEY`, `LLM_FALLBACK_API_KEY` | where listed | New key at the provider, set, redeploy, revoke the old. |
| `FOUNDEROS_SECRET_KEY` | `shell` | Saved repository tokens become unreadable; users must paste them again. There is no re-encrypt step. |
| `GPU_NODE_TOKEN` and `GATEWAY_TOKEN` | `api` and the PC | Change both (they must be equal) and restart the pull agent. AI jobs wait until it reconnects. |
| `BACKUP_TOKEN` | `api` and the PC puller | Change both. |
| Database passwords | Railway database services | Regenerate in the Railway dashboard (what it offers is **not verified** here), make sure the services' `DATABASE_URL` variables are references to it, redeploy. Update `DATABASE_URL` in any off-platform backup job. |
| A leaked LegalAI account password | LegalAI admin | There is no password reset flow yet (docs/SECURITY.md). An admin can deactivate the account (`PATCH /api/admin/users/<id>` with `{"is_active": false}`), which ends its sessions at once. |
After rotating, search the audit log and `git log` for places the old value might have been pasted. Secrets must never be in git (`.env` is ignored).

## Resetting a stuck LegalAI job queue
States (modules/legal/api/legalai/jobs/queue.py): `NEW`, `QUEUED`, `WAITING_FOR_GPU`, `RUNNING`, `VALIDATING`, `COMPLETE`, `RETRYABLE`, `FAILED`, `CANCELED`. The worker (in the `api` process) picks up `QUEUED`, `WAITING_FOR_GPU` and `RETRYABLE` jobs. Most "stuck" jobs are just waiting for the GPU PC, so check that first.

1. **Is the worker alive?** `GET /api/admin/health` (as admin): `worker.seconds_since_tick` should be under 30, `queue.oldest_waiting_minutes` shows how long the oldest job has waited, `gpu` shows the heartbeat. If the worker is dead restart the `api` service.
2. **Is the GPU PC online?** Start Ollama and the pull agent (docs/gpu-node-windows.md). `WAITING_FOR_GPU` jobs resume by themselves when the heartbeat returns. `RUNNING` jobs whose worker died are put back to `RETRYABLE` automatically after `GPU_REQUEST_TIMEOUT_S + 120` seconds.
3. **See the queue.** On the LegalAI database (Railway: the pgvector service's data tab or `psql` through its TCP proxy):
   ```sql
   SELECT state, job_type, count(*), min(created_at) AS oldest FROM jobs GROUP BY 1, 2 ORDER BY 1, 2;
   SELECT id, job_type, state, attempts, max_attempts, status_message, left(error, 120) FROM jobs
   WHERE state IN ('RUNNING','RETRYABLE','FAILED') ORDER BY created_at DESC LIMIT 20;
   ```
4. **Force the reap now** (jobs `RUNNING` with a dead worker; do this only after confirming the worker was restarted):
   ```sql
   UPDATE jobs SET state = 'RETRYABLE', status_message = 'Reset by operator', next_attempt_at = now()
   WHERE state = 'RUNNING' AND started_at < now() - interval '15 minutes';
   ```
5. **Retry a failed job once more** (FAILED to QUEUED is the allowed manual retry):
   ```sql
   UPDATE jobs SET state = 'QUEUED', attempts = 0, error = NULL, finished_at = NULL, next_attempt_at = now(), status_message = 'Retried by operator'
   WHERE id = '<job id>' AND state = 'FAILED';
   ```
6. **Abandon work nobody needs** (users can also cancel their own jobs in the app, `POST /api/jobs/<id>/cancel`):
   ```sql
   UPDATE jobs SET state = 'CANCELED', finished_at = now(), status_message = 'Canceled by operator'
   WHERE state IN ('QUEUED','WAITING_FOR_GPU','RETRYABLE') AND created_at < now() - interval '1 day';
   ```
7. **Pending GPU requests** (`gpu_requests` rows are short-lived and purged after `GPU_REQUEST_TIMEOUT_S + 120` seconds by the worker). If the table has old `pending` or `claimed` rows after the worker is healthy, `DELETE FROM gpu_requests WHERE created_at < now() - interval '1 hour';`.
Take a backup first if you are going to run anything beyond step 3. Jobs with `needs_fallback_approval` wait for a person to approve the external fallback (`POST /api/jobs/<id>/approve-fallback`); that is not a stuck job.

## Health checks
Run after every deploy and when something feels wrong.
| Check | How | Healthy |
|---|---|---|
| Shell alive | `curl -fsS https://<shell>/healthz` | `{"ok":true}` |
| LegalAI alive | `curl -fsS https://<api>/healthz` | 200 |
| Shell reaches LegalAI | `curl -i https://<shell>/legal-ui/` | 200, the LegalAI page |
| Private endpoint hidden | `curl -i -X POST https://<shell>/legal-ui/api/internal/users` | 404 |
| Sign-in works | sign in at `/login`, dashboard loads | no error banner; `e2e/` automates this (docs/E2E.md) |
| LegalAI internals | `GET /api/admin/health` as admin | `"ok": true`; `worker`, `database`, `storage` ok; `backup` fresh when enabled |
| Job queue | same endpoint, `queue.oldest_waiting_minutes` | small unless the GPU PC is off |
| GPU PC | LegalAI Settings, or `checks.gpu` | online (optional check) |
| Scheduler | `SELECT job, max(ran_at) FROM scheduled_runs GROUP BY job;` on the shell database | each job ran in the last day (weekly jobs excepted) |
| Shell backup | /admin/backups: no red banner, newest row verified and under 36 hours; on the PC `pull.log` ends `OK:` (docs/BACKUPS.md) | fresh, verified |
| Server errors | /admin/errors | no unexpected open groups |
| LegalAI backup | admin health `checks.backup`, Settings page | fresh, "restore verified" |
| Rate limiter not throttling real users | try a normal burst of requests; a 429 with `Retry-After` is the only symptom | none under normal use |
| Database size | `SELECT pg_size_pretty(pg_database_size(current_database()));` | well under the Railway volume size |
| Costs | Railway usage page; LegalAI `GET /api/admin/metrics` budgets | under your alert and hard limit |
| Security headers | `curl -sI https://<shell>/ \| grep -i -E "content-security|strict-transport|x-frame"` | present |

## Demo data
`npx tsx shell/scripts/seed-demo.ts <ownerUserId>` creates or updates "BrightSide Cleaning LLC" (North Carolina, residential cleaning, 2 employees, 1 contractor, website, recurring customers) for a LegalAI user id: three vault documents (customer service agreement, contractor agreement, privacy policy as small generated text files), a compliance sync, 6 tasks, 8 contacts and 3 opportunities, 2 SOP documents, 5 saved finance calculations and one competitor (recorded, never fetched). It goes through each tool's own API handlers, so it behaves as the product does, and running it again changes nothing. It reads `DATABASE_URL` (default: the local dev database) and **refuses any database whose host is not localhost or 127.0.0.1** unless `--yes-i-mean-production` is passed. Find a user id with `SELECT user_id FROM business_members;` or from the LegalAI `users` table. Remove the demo business with `DELETE FROM businesses WHERE name = 'BrightSide Cleaning LLC' AND id IN (SELECT business_id FROM business_members WHERE user_id = '<id>');` (everything cascades).

## Quick reference
| I want to... | Do this |
|---|---|
| deploy | `railway up -s api -c` then `railway up -s shell -c` |
| roll back | Railway, service, Deployments, redeploy the previous one; `api` and `shell` independently; migrations stay applied |
| check everything is up | the [health checks](#health-checks) |
| take a verified shell backup now | /admin/backups, Run backup now (or `node shell/scripts/backup-shell.mjs --out <dir> --verify-restore`) |
| prove a backup restores | `node shell/scripts/restore-check.mjs <dir>` |
| unblock a user hitting 429 | wait for `Retry-After`; restart the `shell` service to clear the in-memory counters |
| turn the scheduler off | `SCHEDULER_DISABLED=1`, restart |
| fill a local database with a demo business | `npx tsx shell/scripts/seed-demo.ts <ownerUserId>` |
| run the browser tests | docs/E2E.md |
