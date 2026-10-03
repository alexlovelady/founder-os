# FounderOS monorepo

- `shell/` Next.js SaaS shell. `modules/<name>/` independent tools. `services/gpu-gateway/` private GPU agent. `docs/` platform docs.
- Read `docs/ARCHITECTURE.md` before changing anything that crosses folders. Modules never import each other.
- LegalAI (`modules/legal`): `cd modules/legal/api && ../../../.venv/Scripts/python -m pytest -q`; UI: `cd modules/legal/web && npm run build`
  then it is copied into `api/static` (Docker does this). Deploy: `railway up -s api -c` from the repo root.
- Never commit secrets. Every business-owned record is tenant-scoped. Validate input server-side. Do not bypass auth.
- Update this file and docs/ARCHITECTURE.md when architecture changes.
