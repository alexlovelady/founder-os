# FounderOS monorepo

## Product overview
FounderOS is an AI-assisted back office for founders, freelancers and small businesses: contracts, documents, compliance, tasks, customers and money in one place. One SaaS shell (Next.js) owns the customer, the business profile, plans, billing and the dashboard; each tool is its own folder and publishes what it knows so every other tool and the assistant can use it. FounderOS is software, not a law firm, accounting firm or adviser: never write copy or code that claims otherwise, claims a certification, invents customer numbers, testimonials or ratings, or describes a feature that does not exist. The product spec is `docs/FounderOS_Build_Spec.md`; what is left and who must do it is `docs/PLAN.md`.

## Tech stack
* Shell and tools: Next.js 16 (App Router; **not the Next.js you know**, read `shell/AGENTS.md` and `node_modules/next/dist/docs/` (hoisted to the repo root) before writing pages), React 19, TypeScript, Tailwind 4, zod 4, `postgres` (porsager) with raw SQL, vitest. npm workspaces at the repo root. Node 22.
* LegalAI (`modules/legal/`): Python 3.12, FastAPI, SQLAlchemy and Alembic, Postgres with pgvector, React (Vite) UI in `modules/legal/web`. Own database.
* AI: private GPU on the owner's PC (Ollama, qwen3 models) reached by a pull agent through LegalAI's job queue. No third-party AI provider by default. See `docs/AI_SYSTEM.md`.
* Identity: interim LegalAI accounts behind `IdentityProvider` (`shell/src/lib/auth/provider.ts`). **Firebase is not used.**
* Hosting: Railway (services `shell`, `api`, `Postgres`, `postgres`). Billing: Stripe (code complete, off until keys exist).

## Architecture rules
1. The shell owns the customer; modules own the work. A module (tool) **never imports another module**. Tools share through the context: `facts()`, `describe()` (600 characters or less), `attention()`, `resolve()`, `search()`, and `ctx.links`. Read `docs/ARCHITECTURE.md` before changing anything that crosses folders and `docs/TOOLS.md` before building a tool.
2. One business = one tenant. The business, user and role come from the verified session membership, **never from the request**. Every tool query filters by `ctx.businessId`.
3. AI goes through `ctx.ai` (tier `fast` or `deep`), is asynchronous (start, then poll), may be unavailable or slow, must have a non-AI path where reasonable, is labelled as AI output, and is never called inside `facts`, `describe`, `attention` or `search`. Count usage with `ctx.useQuota("ai_request")` before starting AI. Models propose; people confirm.
4. LegalAI is a separate service reached over `LEGAL_URL` and proxied under `/legal-ui`. It stays Python.
5. Honesty: no fake data; if a feature is not built, say so in the UI; legal, tax and financial output carries a short "not advice" note; public pages follow the copy rules in `docs/SITE.md`.
6. Update this file, `docs/ARCHITECTURE.md` and the relevant doc whenever the architecture changes.

## Important directories
* `shell/src/app/` routes: `(site)` public pages and free tools, `app/` signed-in app, `admin/` platform admin, `api/` routes (`api/tools/[tool]/...` is the generic tool API), `login`, `invite`, `healthz`.
* `shell/src/lib/` shell logic: `auth`, `tools` (context, AI client, plan wiring), `billing`, `notify` (notifications, scheduler, email), `team`, `platform` (audit, privacy, flags, feedback, headers), `site` (public page list in `pages.ts`), `legal.ts` and `legalbridge`.
* `shell/src/config/plans.ts` plans, prices and limits: the only place. `shell/migrations/` platform SQL migrations.
* `modules/sdk/` tool contract and test harness. `modules/<id>/` one tool each (`src/index.tsx` exports `tool`, `test/`, `README.md`).
* `modules/legal/api/legalai/` LegalAI backend; `modules/legal/docs/` its docs. `services/gpu-gateway/` the pull agent. `docs/` platform docs.

## Database conventions
Full version in `docs/DATABASE.md`.
* Every tenant table: `business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE`, and every query filters by it. Tool tables are prefixed with the tool id (`crm_*`).
* Shell migrations: `shell/migrations/NNNN_name.sql`, run at container start by `scripts/migrate.mjs`, **must be idempotent**, never edit an applied one; two agents never share a number (the lead assigns them). Tool migrations: append `{ name, sql }` to `tool.migrations`; never edit applied ones. The platform admin tables of the compliance tool are the one documented exception to the `business_id` rule.
* Ids are `uuid DEFAULT gen_random_uuid()`, timestamps `timestamptz DEFAULT now()`. No secrets in plain columns; name unavoidable ones with `token`, `secret`, `password` or `encrypted` so exports and admin views skip them.

## Security rules
Full status in `docs/SECURITY.md`. Never commit secrets (`.env` is git-ignored); secrets come from server environment variables only. Validate every request body server-side with zod (`readJson`); recompute anything derived on the server. Writes call `requireWrite(ctx)` (viewers are read-only). Do not bypass auth, do not add endpoints that take a business or user id from the client, do not log request bodies, prompts, document contents or tokens. Any feature that fetches a user-supplied URL must use an SSRF-safe fetcher (`modules/competitors/src/safe-fetch.ts`, `modules/legal/api/legalai/corpus/safe_fetch.py`). State-changing platform endpoints check `Origin` against `Host`. Platform admin is the LegalAI role `admin`, checked on the server; non-admins get 404. Never perform or script actions an assistant must not (creating real accounts, moving money, deleting production data).

## Testing commands
```
npx vitest run                          # every tool and shell library; needs Postgres on :5442 with database founderos_test
npx vitest run modules/<id>             # one tool
npx vitest run shell/tests/site         # public site checks (sitemap, metadata, one h1, forbidden-claims list)
cd shell && npx tsc --noEmit            # typecheck shell and tools
cd shell && npm run lint                # lint the shell (tools: npx --prefix shell eslint -c shell/eslint.config.mjs modules/*/src modules/*/test)
cd shell && npm run build               # production build
cd modules/legal/api && ../../../.venv/Scripts/python -m pytest -q    # LegalAI; needs the compose Postgres
```
Local setup: `npm install`, `docker compose up -d db`, then the steps in `README.md`. Tool tests use a real Postgres via `makeTestEnv`. A tool is not done until it has tests for the happy path, validation, tenant isolation, viewer read-only, and each published fact, describe, search and resolve.

## Deployment process
Railway, from the repository root: `railway up -s api -c` (LegalAI) and `railway up -s shell -c`. Each service selects its Dockerfile with `RAILWAY_DOCKERFILE_PATH` (`shell/Dockerfile`, `modules/legal/api/Dockerfile`); the root `railway.json` holds only the common settings. Deploy `api` before `shell` when both change. Migrations run on start. CI (`.github/workflows/ci.yml`) checks only; it does not deploy. Details, variables and rollback: `docs/DEPLOYMENT.md`, `docs/railway.md`. Do not run git, Railway or deploy commands unless the user asked.

## Coding standards
* TypeScript strict; no `any` without a reason; pure functions for domain logic so it works in the browser and in tests; keep tool packages free of shell imports.
* Match the surrounding code. Prefer editing existing files; no new dependencies without a reason. No comments that restate the code; comment the why.
* UI: Tailwind, dark slate theme, accessible (labels, roles, keyboard), works at phone width, every AI feature shows progress and a "check this" label.
* Public pages: one `h1` (via `PageShell`), `export const metadata = pageMetadata("/path")`, and an entry in `shell/src/lib/site/pages.ts`; tests fail otherwise. The forbidden-claims test scans the site files.
* Windows: write files with the editor tools, not shell heredocs (apostrophes break them); use `/c/...` paths in Git Bash.
* Errors tell the user plainly what happened and what to do; HTTP errors from tools use `HttpError` with a message the UI can show.
