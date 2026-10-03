# Development

## One-time setup
```
npm install                                  # repo root: installs the shell and every tool (npm workspaces)
docker compose up -d db                      # local Postgres on :5442 (the compose file in the repo root)
docker exec legalai-db-1 psql -U legalai -d legalai -c "CREATE DATABASE founderos"
docker exec legalai-db-1 psql -U legalai -d legalai -c "CREATE DATABASE founderos_test"
```

## Run the shell locally
```
cd shell
export DATABASE_URL=postgresql://legalai:legalai-dev@localhost:5442/founderos
node scripts/migrate.mjs                     # base tables; tool tables are migrated when the server starts
npm run build && npm start -- -p 3000        # LegalAI must be running on :8000 (see modules/legal/README.md) or set LEGAL_URL
```
Sign in with a LegalAI account. Locally, create one with the LegalAI dev database (see modules/legal/README.md).

## Tests
```
npx vitest run                               # every tool (needs the founderos_test database)
npx vitest run modules/finance               # one tool
cd shell && npx tsc --noEmit && npm run lint # shell + tools typecheck and lint
cd modules/legal/api && ../../../.venv/Scripts/python -m pytest -q   # LegalAI
```

## Git
Remote `founderos` = github.com/alexlovelady/founder-os (branch `main`). Commit per milestone.
