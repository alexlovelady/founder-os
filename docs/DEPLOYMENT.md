# Deployment (Railway)

Written from `docs/railway.md`, `railway.json`, `shell/Dockerfile`, `modules/legal/api/Dockerfile`, `modules/legal/api/legalai/config.py`, the shell source and `.github/workflows/ci.yml`, on 2026-10-03. This file does not claim anything about the live Railway project that the repository cannot show; those items are marked "not verified". For billing keys see docs/BILLING.md; for the GPU PC see docs/gpu-node-windows.md; for security status see docs/SECURITY.md.

## Services

| Railway service | What | Built from | Reachable by |
|---|---|---|---|
| `shell` | The FounderOS Next.js app: public site, sign-in page, dashboard, every tool, `/admin`, the proxy to LegalAI. Runs the in-process scheduler. | `shell/Dockerfile` | The internet (documented address: `https://shell-production-86b1.up.railway.app`) |
| `api` | LegalAI: FastAPI, the React UI (copied into `static/` at build), the embedded job worker, the pull-mode GPU endpoints. | `modules/legal/api/Dockerfile` | The shell over Railway's private network (`api.railway.internal:8080`). It also keeps a public address, because the owner's GPU PC polls it (`/api/gpu/claim`) and the off-site backup puller calls it. |
| `Postgres` | The shell's database (businesses, memberships, every tool's tables, billing, notifications, audit). | Railway Postgres | `shell` only |
| `postgres` (pgvector) | LegalAI's database. Must be a pgvector-enabled Postgres: the first migration runs `CREATE EXTENSION vector`. | Railway pgvector template | `api` only |

`docs/ARCHITECTURE.md` documents these names. `docs/PLAN.md` records an empty extra Railway database (`Postgres--1wG`) that the owner should delete in the Railway dashboard; nothing in this repository uses it.

There is no Redis and no Qdrant. One service (`api`) owns the document volume, which is why the worker runs inside the API process (`RUN_WORKER=true`).

### How a service picks its Dockerfile
The root `railway.json` holds only settings common to all services:
```json
{ "build": { "builder": "DOCKERFILE" }, "deploy": { "healthcheckPath": "/healthz", "restartPolicyType": "ON_FAILURE" } }
```
Each service selects its file with a service variable, `RAILWAY_DOCKERFILE_PATH`: `shell/Dockerfile` for `shell` and `modules/legal/api/Dockerfile` for `api`. Both build with the repository root as the Docker context (Railway uploads from the root). Both services expose `/healthz` (the shell's route answers `{ "ok": true }`).

## Build and deploy commands
From the repository root, with the Railway CLI linked to the project:
```bash
railway up -s api -c       # deploy LegalAI
railway up -s shell -c     # deploy the shell
```
`-c` streams the build logs and exits when the build ends. Nothing deploys automatically from CI: `.github/workflows/ci.yml` runs checks only (below).

What each image does:
* **shell** (`node:22-slim`): `npm ci` at the root (the shell and every tool are npm workspaces), then `npm run build --workspace shell` (Next.js `output: "standalone"`). The runtime command is `node shell/scripts/migrate.mjs && node shell/server.js`: shell SQL migrations (`shell/migrations/NNNN_*.sql`, tracked in `schema_migrations`) run before the server starts, and **tool** migrations run when the server starts (`instrumentation.ts`, under an advisory lock). The scheduler also starts there.
* **api** (`python:3.12-slim`): builds the React UI in a Node stage and copies it to `static/`; installs Tesseract (OCR) and `postgresql-client-16` (so scheduled backups can `pg_dump`); the start command is `alembic upgrade head && uvicorn legalai.main:app --host 0.0.0.0 --port ${PORT:-8000}`. Railway supplies `PORT`; the documented private address uses 8080.

Local equivalents: `cd shell && npm run build` (verifies the app compiles), `docker compose up -d db` for Postgres. See README.md and docs/DEVELOPMENT.md.

### CI (no deploy)
`.github/workflows/ci.yml` on pull requests and pushes to `main`: shell typecheck (`npx tsc --noEmit`), shell lint, tool lint, `npx vitest run` against a Postgres 16 service (`founderos_test`), `npm run build --workspace shell`; and a second job that installs the LegalAI package and runs `python -m pytest -q`.

## Environment variables

### `shell`
| Variable | Needed | Purpose |
|---|---|---|
| `RAILWAY_DOCKERFILE_PATH` | yes | `shell/Dockerfile` |
| `DATABASE_URL` | yes | Reference the `Postgres` service's connection string (plain `postgresql://...`, no driver prefix). The container refuses to migrate without it. |
| `LEGAL_URL` | yes | Private address of LegalAI, `http://api.railway.internal:8080`. It is a Docker **build argument** (the rewrites in `next.config.ts` are fixed at build time) and is also read at runtime by server code. Changing it needs a redeploy. |
| `APP_URL` | recommended | Public base URL for links in emails and Stripe return links. |
| `NEXT_PUBLIC_APP_URL` | recommended | Base URL for the sitemap, canonical links and OpenGraph. Falls back to `https://$RAILWAY_PUBLIC_DOMAIN`, then `http://localhost:3000`. It is a `NEXT_PUBLIC_` variable, which Next.js reads at build time, and `shell/Dockerfile` only declares `LEGAL_URL` as a build argument. Not verified: whether Railway passes this variable into the build. If canonical URLs come out wrong, add an `ARG`/`ENV` pair for it in the Dockerfile. |
| `NEXT_PUBLIC_CONTACT_EMAIL` | optional | Shown on `/contact` and `/security`; hidden when unset. Build-time, same caveat. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FOUNDER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`, `STRIPE_TRIAL_DAYS` | optional | Billing. Setting `STRIPE_SECRET_KEY` is what turns plan limits on (docs/BILLING.md). |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional (both or neither) | Email sending. |
| `SEARCH_API_KEY` | optional | Brave Search for competitor discovery. |
| `FOUNDEROS_SECRET_KEY` | optional | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts saved repository tokens in Product Scan. Rotating it makes stored tokens unreadable. |
| `SCHEDULER_DISABLED`, `SCHEDULER_TICK_MS` | optional | `1` disables the in-process scheduler; tick defaults to 10 minutes. |
| `INTERNAL_PROVISION_TOKEN` | optional (needed for signup) | Shared secret, 32 or more random characters, **the same value on `shell` and `api`**. If unset or shorter, signup answers 503 on the shell and LegalAI answers 404 to `/api/internal/*`. Never give it a `NEXT_PUBLIC_` prefix. |
| `SIGNUP_MODE` | optional | `closed` (default), `invite` or `open`. Keep `open` off: there is no email verification yet (docs/SIGNUP.md). |
| `SIGNUP_HASH_SECRET`, `SIGNUP_TRUSTED_PROXY_HOPS` | optional | Key for signup attempt hashes (falls back to the token) and the number of proxies in front of the shell (default 1). See docs/SIGNUP.md. |

### `api` (LegalAI)
| Variable | Value |
|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `modules/legal/api/Dockerfile` |
| `APP_ENV` | `production` |
| `COOKIE_SECURE` | `true` |
| `SESSION_SECRET` | `python -c "import secrets;print(secrets.token_urlsafe(48))"`. Rotating it signs everyone out and invalidates enrolled authenticator secrets (they are encrypted with a key derived from it). |
| `DATABASE_URL` | the pgvector service's string with the driver prefix changed to `postgresql+psycopg://...` |
| `STORAGE_DIR` | `/data/storage` (a Railway **Volume** must be mounted at `/data`) |
| `RUN_WORKER` | `true` |
| `TRUST_PROXY` | `true` (honour `X-Forwarded-For` behind Railway) |
| `GPU_MODE` | `pull` (the default) |
| `GPU_NODE_TOKEN` | long random value, identical to `GATEWAY_TOKEN` on the PC |
| `GPU_NODE_ID` | `home-5070ti` (same as `NODE_ID` on the PC) |
| `GPU_NODE_URL` | only used in push mode; docs/railway.md still lists it, but pull mode does not need it |
| `FAST_MODEL`, `DEEP_MODEL`, `CRITIC_MODEL`, `EXTRACTION_MODEL` | `qwen3:14b`, `qwen3:30b`, `qwen3:14b`, `qwen3:14b` (as documented) |
| `LLM_FALLBACK_PROVIDER`, `EXTERNAL_LLM_MONTHLY_BUDGET_USD` | `disabled`, `0`. Keep it this way unless you deliberately opt in. |
| `BACKUP_ENABLED`, `BACKUP_TOKEN` | `true`, a long random value for the off-site puller. Also `BACKUP_INTERVAL_HOURS` (24), `BACKUP_INCLUDE_STORAGE` (false), `BACKUP_VERIFY` (true), `BACKUP_DIR`. |
| `DEFAULT_PRIVACY_MODE` | `private` (the default) |
| `EMBEDDING_PROVIDER`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` | Default provider is `external` (Voyage) but it is only used when a key is set and the matter allows it; otherwise embeddings run on the GPU. Set `EMBEDDING_PROVIDER=local` to forbid external embeddings outright. |
| `COURTLISTENER_TOKEN`, `CLAMAV_HOST`, `CLAMAV_REQUIRED`, `OCR_*` | optional |
| `EMBED_ORIGINS` | Not needed while the shell proxies LegalAI under `/legal-ui` (same origin). Lists extra origins allowed to frame LegalAI. |
| `INTERNAL_PROVISION_TOKEN` | Same value as on the shell (32+ characters). Empty disables `/api/internal/*`, which then answers 404. |

The full list of LegalAI settings, with defaults, is `modules/legal/api/legalai/config.py`.

### GPU PC (not on Railway)
`services/gpu-gateway/.env`: `GATEWAY_TOKEN`, `API_URL` (the `api` service's **public** address), `NODE_ID`, `GATEWAY_ALLOWED_MODELS`. Set `OLLAMA_CONTEXT_LENGTH=16384`. Full steps in docs/gpu-node-windows.md. The PC makes outbound HTTPS only; nothing listens on it.

## Domains
* Railway gives each service a generated `*.up.railway.app` address. The shell's is the public face. LegalAI users never need `api`'s address because the shell proxies the UI under `/legal-ui`.
* Custom domains (for example `app.<yourdomain>` for the shell) are added in the Railway dashboard with DNS records at your registrar; no code change is needed, but update `APP_URL`, `NEXT_PUBLIC_APP_URL` (and rebuild), the Stripe webhook endpoint (docs/BILLING.md step 5) and, if you set it, `EMBED_ORIGINS`. Not done today: custom domain and email sending domain both need DNS access (docs/PLAN.md).

## First-run bootstrap (empty project)
1. Create the pgvector Postgres service and the `api` service with the variables above, a Volume at `/data`, and deploy it (`railway up -s api -c`). Open `/healthz` on its public domain.
2. Create the **first account once** (it becomes the platform administrator):
   `curl -X POST https://<api public domain>/api/auth/bootstrap -H "content-type: application/json" -d '{"email":"you@example.com","password":"<12+ characters>"}'`
   The endpoint refuses once any user exists. (Creating the account is something the owner does; an assistant must not.)
3. Create the shell's `Postgres` service and the `shell` service with `DATABASE_URL`, `LEGAL_URL` and `RAILWAY_DOCKERFILE_PATH`; deploy (`railway up -s shell -c`). Shell migrations run at container start; tool tables are created on first server start. Open `/healthz`, then `/`.
4. Sign in at `/login` with the bootstrap account. Create the business (onboarding); the shell creates the business's LegalAI workspace so AI and the legal checklist work. If LegalAI was unreachable the dashboard re-links it.
5. Start Ollama and the pull agent on the PC (docs/gpu-node-windows.md). The LegalAI Settings page shows the GPU online within a poll; until then AI jobs wait.
6. Optional: Stripe, email, search, `FOUNDEROS_SECRET_KEY`. Each turns on only when its variables exist.
7. Cost controls in the Railway dashboard: a usage alert and, plan permitting, a hard limit; watch Postgres and volume sizes.

### Accounts
LegalAI is the interim identity provider. The first account comes from the bootstrap call above. Further accounts are created by a LegalAI administrator, or by the self-serve signup flow when it is enabled: `/signup` on the shell calls LegalAI's private `POST /api/internal/users` with the shared `INTERNAL_PROVISION_TOKEN`. Signup is **closed by default** (`SIGNUP_MODE`), and `invite` mode uses codes created at `/admin/signup`. `shell/next.config.ts` has a rewrite that answers 404 for `/legal-ui/api/internal/:path*` ahead of the proxy rule, so the private endpoint is not reachable through the shell (docs/SIGNUP.md says to verify with `curl -i -X POST https://<shell>/legal-ui/api/internal/users`; I did not run that against the live service). There is no password reset flow and no email verification (docs/SIGNUP.md).

## Staging
Use a separate Railway environment with its own databases, volume, `SESSION_SECRET`, and a different `GPU_NODE_TOKEN` (the pull agent accepts one token per instance; run a second agent with its own `.env` for staging). Use Stripe test mode there.

## Backups
* **LegalAI:** with `BACKUP_ENABLED=true` the worker writes a daily dump, restores it into a scratch database, checks row counts and every document hash, records the verdict and keeps 7 daily and 4 weekly copies under `/data/backups`. They share the data volume, so also run `scripts/pull_backup.py` on the PC from Task Scheduler (`modules/legal/docs/backup.md`).
* **Shell database:** no automation in this repository. Enable Railway Postgres backups for **both** databases and do a restore test. Whether that has been done is **not verified** (docs/SECURITY.md).

## Rollback
* **Code:** in the Railway dashboard open the service's Deployments and redeploy or roll back to the previous successful deployment; or check out the previous commit and `railway up -s <service> -c`. Each service rolls back independently.
* **Schema:** rollback does not undo migrations. Shell migrations and tool migrations only move forward and are written to be additive and re-runnable, so a previous shell image generally still runs against a newer schema, but this is not tested. LegalAI uses Alembic; a down-migration would be `alembic downgrade -1` run in the service shell, and it is not tested either. For anything destructive, restore from a verified backup into a new database and point `DATABASE_URL` at it.
* **Order:** if a release changes both services, deploy `api` first, then `shell` (the shell calls the API). Roll back in the reverse order.
* **Config:** a bad variable change is reverted in the dashboard and redeployed. `LEGAL_URL` changes need a rebuild of `shell`.
* **Billing:** rolling back the shell does not change anything in Stripe; webhook handling is idempotent by event id.
