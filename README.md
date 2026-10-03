# FounderOS

An AI-assisted back office for founders, freelancers and small businesses: contracts, documents, compliance, tasks, customers and money in one place, with tools that share what they know about your business. Each tool is its own module in its own folder.

FounderOS is software, not a law firm, accounting firm or financial adviser. Nothing it produces is legal, tax or financial advice, and AI output can be wrong. Access is by invitation for now; there is no live billing yet (see "Stripe").

## What is in the repository

```
shell/                  FounderOS web app (Next.js 16, TypeScript): public site and free tools, sign-in, business profile,
                        dashboard, every tool's pages and API, billing, team, notifications, platform admin
modules/
  sdk/                  The tool contract (ToolDef, ToolContext), migrations runner, UI helpers, test harness
  finance/ compliance/ health/ tasks/ vault/ sops/ crm/ marketing/ founderai/ product/ competitors/
                        The tools (TypeScript packages, one folder each, compiled by the shell)
  legal/                LegalAI: contract review, drafting, cited research, legal library (FastAPI + Postgres/pgvector + React)
services/gpu-gateway/   Pull-mode agent that runs AI models on the owner's Windows PC (Ollama)
docs/                   Platform docs (list below)
```

Tools never import each other; they share facts and summaries through the shell's context (docs/ARCHITECTURE.md, docs/TOOLS.md).

## Documentation
Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Database: [docs/DATABASE.md](docs/DATABASE.md) · AI: [docs/AI_SYSTEM.md](docs/AI_SYSTEM.md) · LegalAI: [docs/LEGAL_AI.md](docs/LEGAL_AI.md) · Compliance: [docs/COMPLIANCE.md](docs/COMPLIANCE.md) · Security: [docs/SECURITY.md](docs/SECURITY.md) · Billing: [docs/BILLING.md](docs/BILLING.md) · Notifications: [docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md) · Team: [docs/TEAM.md](docs/TEAM.md) · Signup: [docs/SIGNUP.md](docs/SIGNUP.md) · Admin: [docs/ADMIN.md](docs/ADMIN.md) · Public site: [docs/SITE.md](docs/SITE.md) · Integrations: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) · Deployment: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · Development: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · Building a tool: [docs/TOOLS.md](docs/TOOLS.md) · What is left: [docs/PLAN.md](docs/PLAN.md) · Roadmap: [docs/ROADMAP.md](docs/ROADMAP.md) · Product spec: [docs/FounderOS_Build_Spec.md](docs/FounderOS_Build_Spec.md). LegalAI's own README is [modules/legal/README.md](modules/legal/README.md); each tool has a README in its folder.

## Local setup
Requirements: Node 22, Docker (for Postgres), and for LegalAI Python 3.12. On Windows use Git Bash or PowerShell.

```bash
npm install                                   # repo root: installs the shell and every tool (npm workspaces)
docker compose up -d db                       # Postgres (pgvector) on localhost:5442
docker exec legalai-db-1 psql -U legalai -d legalai -c "CREATE DATABASE founderos"
docker exec legalai-db-1 psql -U legalai -d legalai -c "CREATE DATABASE founderos_test"
```

Run LegalAI (needed to sign in and for AI):
```bash
py -3.12 -m venv .venv
.venv/Scripts/pip install -e "modules/legal/api[dev]"
cp .env.example modules/legal/api/.env        # LegalAI reads .env from its working directory; fill SESSION_SECRET (see the comment in the file)
cd modules/legal/api
../../../.venv/Scripts/alembic upgrade head
../../../.venv/Scripts/uvicorn legalai.main:app --reload          # http://localhost:8000
# in another shell, create your local account once (becomes admin; refuses once any user exists):
curl -X POST http://localhost:8000/api/auth/bootstrap -H "content-type: application/json" -d '{"email":"you@example.com","password":"at-least-12-characters"}'
```

Run the shell:
```bash
cd shell
export DATABASE_URL=postgresql://legalai:legalai-dev@localhost:5442/founderos
node scripts/migrate.mjs                      # base tables; each tool creates its own tables when the server starts
npm run dev                                   # http://localhost:3000   (or: npm run build && npm start)
```
The shell finds LegalAI at `LEGAL_URL` (default `http://localhost:8000`). Sign in at `/login` with the account you just created.

AI locally needs Ollama and the pull agent on your machine; see "AI provider setup". Without it everything else works and AI features say they are unavailable or waiting.

## Environment variables
Full tables with defaults are in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The ones you will meet first:

| Variable | Service | Purpose |
|---|---|---|
| `DATABASE_URL` | shell | The shell's Postgres (`postgresql://...`). Required. |
| `LEGAL_URL` | shell | LegalAI's address (default `http://localhost:8000`; on Railway `http://api.railway.internal:8080`). Fixed at build time for the proxy rewrites. |
| `NEXT_PUBLIC_APP_URL`, `APP_URL`, `NEXT_PUBLIC_CONTACT_EMAIL` | shell | Public base URL, link base for emails and Stripe, optional contact address. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` | shell | Billing (optional, off until set). |
| `RESEND_API_KEY`, `EMAIL_FROM` | shell | Email (optional). |
| `SEARCH_API_KEY` | shell | Brave Search for competitor discovery (optional). |
| `FOUNDEROS_SECRET_KEY` | shell | 32 random bytes, base64: encrypts saved repository tokens (optional). |
| `TEST_DATABASE_URL` | tests | Defaults to `postgresql://legalai:legalai-dev@localhost:5442/founderos_test`. |
| `SESSION_SECRET`, `DATABASE_URL` (`postgresql+psycopg://...`), `COOKIE_SECURE`, `STORAGE_DIR` | LegalAI | Copy `.env.example` to `modules/legal/api/.env` (the Docker compose file reads a root `.env`). |
| `GPU_NODE_TOKEN`, `GPU_NODE_ID`, `FAST_MODEL`, `DEEP_MODEL`, ... | LegalAI | GPU and model settings; see `.env.example`. |

Never commit secrets: `.env` files are git-ignored.

## Firebase
**Firebase is not used.** The product spec called for Firebase Auth; the owner chose to keep **LegalAI accounts as the interim identity provider**. The shell signs users in through LegalAI behind an `IdentityProvider` interface (`shell/src/lib/auth/provider.ts`), so a Firebase (or other) provider can replace it later without touching the pages. Consequences today: one global user table owned by LegalAI; accounts are created by a LegalAI administrator (the first one with the bootstrap call above) or, when enabled, through the shell's self-serve signup (`SIGNUP_MODE`, closed by default, docs/SIGNUP.md); and there is no password reset flow or email verification. See docs/SECURITY.md and docs/TEAM.md.

## Stripe
Code is complete and **inactive until keys exist**. Without `STRIPE_SECRET_KEY` the billing page says "Billing is not enabled yet", every business gets the Business plan limits, and checkout answers 503. To switch it on: create the products and monthly prices, enable the customer portal, set the variables, add the webhook endpoint, and test in Stripe test mode first. Step by step: [docs/BILLING.md](docs/BILLING.md). Plans and limits live in one file, `shell/src/config/plans.ts`.

## AI provider setup
AI runs on a **private GPU** you operate, through the LegalAI job queue. Tools ask for a tier (`fast` or `deep`); LegalAI maps it to a model name from `FAST_MODEL` / `DEEP_MODEL`; your PC pulls the job over an outbound connection and runs it on Ollama. No third-party AI provider is configured by default and nothing is trained on your data.

1. Install Ollama and pull the models (`qwen3:14b`, `qwen3:30b`, `qwen3-embedding:0.6b`), and set `OLLAMA_CONTEXT_LENGTH=16384`.
2. Set `GPU_NODE_TOKEN` (and `GPU_NODE_ID`) in LegalAI's environment and the same token as `GATEWAY_TOKEN` in `services/gpu-gateway/.env` with `API_URL` pointing at LegalAI.
3. Run `python pull_agent.py` from `services/gpu-gateway`.

Details, limits and the privacy modes: [docs/AI_SYSTEM.md](docs/AI_SYSTEM.md) and [docs/gpu-node-windows.md](docs/gpu-node-windows.md). Cloud and bring-your-own-key AI tiers are not built.

## Development commands
From the repository root unless noted.

| Task | Command |
|---|---|
| Install everything | `npm install` |
| Run the shell in dev | `cd shell && npm run dev` |
| Production build of the shell | `cd shell && npm run build` |
| Typecheck shell and tools | `cd shell && npx tsc --noEmit` |
| Lint the shell | `cd shell && npm run lint` |
| Lint the tools | `npx --prefix shell eslint -c shell/eslint.config.mjs modules/*/src modules/*/test` |
| Apply shell migrations | `cd shell && node scripts/migrate.mjs` (needs `DATABASE_URL`) |

There is no root `npm run dev` or `npm run lint`; the root scripts are `npm test` (runs `vitest run`) and `npm run typecheck` (only runs workspaces that define a `typecheck` script, which today is none, so use the `tsc` command above).

## Testing
```bash
npx vitest run                                # every tool and the shell libraries (needs the founderos_test database)
npx vitest run modules/finance                # one tool
npx vitest run shell/tests/site               # public site: sitemap, metadata, honest-copy checks
cd modules/legal/api && ../../../.venv/Scripts/python -m pytest -q   # LegalAI (needs the compose Postgres; creates legalai_test)
```
Tool tests run against a real Postgres, not mocks. CI (`.github/workflows/ci.yml`) runs typecheck, lint, the vitest suite, the shell build and the LegalAI tests on every pull request.

## Deployment
Railway, one project, four services: `shell`, `api` (LegalAI), and two Postgres databases. Each service picks its Dockerfile with `RAILWAY_DOCKERFILE_PATH`; deploy one with `railway up -s <service> -c` from the repository root. Variables, domains, first-run bootstrap, GPU agent, backups and rollback: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and [docs/railway.md](docs/railway.md).

Not legal, tax or financial advice. FounderOS is software, not a law firm or accounting firm.
