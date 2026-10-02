# Railway deployment

Two services: **Postgres (pgvector)** and **api** (web + embedded job worker). One service owns the document volume,
which is why the worker runs inside the API process (`RUN_WORKER=true`). No Redis, no Qdrant.

## 1. Database
1. New project → *Add service* → Database → **Postgres with pgvector** (the pgvector template; the stock Postgres image
   lacks the extension). The initial migration runs `CREATE EXTENSION vector`.
2. Note the connection string. SQLAlchemy needs the driver prefix: `postgresql+psycopg://…` (replace `postgresql://`).

## 2. API service
1. *Add service* → GitHub repo (or `railway up`). Set **Root Directory** to `apps/api`; Railway uses the Dockerfile.
   Start command is already `alembic upgrade head && uvicorn …`.
2. Add a **Volume** to this service mounted at `/data`.
3. Variables:
   ```
   APP_ENV=production
   COOKIE_SECURE=true
   SESSION_SECRET=<python -c "import secrets;print(secrets.token_urlsafe(48))">
   DATABASE_URL=postgresql+psycopg://…   (reference the Postgres service variable, change the prefix)
   STORAGE_DIR=/data/storage
   RUN_WORKER=true
   TRUST_PROXY=true
   GPU_NODE_URL=https://<your tunnel hostname>
   GPU_NODE_TOKEN=<same value as GATEWAY_TOKEN on the PC>
   GPU_NODE_ID=home-5070ti
   FAST_MODEL=qwen3:14b
   DEEP_MODEL=qwen3:30b
   CRITIC_MODEL=qwen3:14b
   EXTRACTION_MODEL=qwen3:14b
   LLM_FALLBACK_PROVIDER=disabled
   EXTERNAL_LLM_MONTHLY_BUDGET_USD=0
   ```
   Embedding variables (`EMBEDDING_API_KEY`, Voyage) are not used until Phase 3.
4. Generate a public domain, open `/healthz`.
5. Create your account **once**:
   `curl -X POST https://<domain>/api/auth/bootstrap -H "content-type: application/json" -d '{"email":"you@example.com","password":"<12+ chars>"}'`
   The endpoint refuses once any user exists.

## 3. Staging vs production
Use a separate Railway environment with its own database, volume, `SESSION_SECRET` and a **different**
`GPU_NODE_TOKEN` (the gateway accepts one token per instance; run a second gateway port/token for staging if needed).

## 4. Cost controls (do these in the Railway dashboard)
- Project → Usage → set a **usage alert** and a **hard limit** (plan permitting).
- Watch the Postgres and volume sizes monthly.
- Keep `LLM_FALLBACK_PROVIDER=disabled` and `EXTERNAL_LLM_MONTHLY_BUDGET_USD=0` unless you deliberately opt in.

## 5. Backups
Enable Railway Postgres backups, and periodically `pg_dump` plus a copy of the volume. Do a **restore test** before
loading real matters (spec §25). Not automated yet.
