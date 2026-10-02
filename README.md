# Legal AI Platform

Implements `Legal_AI_Railway_Hybrid_Build_Spec.md`. **Status: Phases 1–3 built** (foundation, home GPU path, RAG).
Phases 4–8 (cited research, contract review, critic, corpus, hardening) are not started.

```
apps/api            FastAPI app, Postgres models/migrations, auth, matters, documents, jobs, embedded worker
services/gpu-gateway  Authenticated gateway in front of Ollama + Windows heartbeat agent
infra/railway       Railway config
docs/               Deployment guides
```

## What exists now
- Single-user-ready auth (argon2, httpOnly session cookie, CSRF header, login rate limit). First account via
  `POST /api/auth/bootstrap` becomes admin; later users are created by the admin. Admins get **no** implicit access to
  matter content.
- Matters with privacy modes (`standard` / `private` / `local_only`), enforced in the backend (`legalai/privacy.py`).
- Document upload: type/magic-byte validation, size limit, sanitized names, SHA-256, versioning, authenticated download.
  Malware scanning is a no-op hook (`storage.scanner`) — plug in ClamAV before accepting untrusted uploads.
- Postgres-backed job queue with the spec's state machine. GPU jobs wait in `WAITING_FOR_GPU` when the node is offline.
  External fallback only runs when *all* hold: provider configured, matter not `local_only`, matter mode `allowed`
  (or `ask` + per-job approval), budget > $0 and not exhausted.
- Provider abstraction (`LLMProvider`, `LocalGpuProvider`, `OpenAICompatibleProvider`); model names come from env roles.
- GPU gateway: bearer token **and** HMAC signature, replay protection, model allowlist, parameter allowlist, size and
  rate limits, streaming, loopback bind. Heartbeat agent keeps Windows awake only while a job is running.
- Audit events for auth, matters, uploads, downloads, jobs, fallback use.

- Phase 3: parsers (PDF, DOCX, TXT, MD, HTML, EML) keep page numbers, headings and exact character offsets;
  structure-aware chunking (articles, numbered provisions, sub-clauses; `text == source[start:end]` is tested);
  embeddings via Voyage (`voyage-law-2`) **or** the private GPU (`qwen3-embedding:0.6b`, 1024-d), chosen per matter by
  privacy mode in the backend (`privacy.embedding_route`), cached by input hash + model; pgvector HNSW + Postgres
  full-text search fused with weighted reciprocal-rank fusion; citation IDs (`CITE-001`) and a source viewer.
  Local-only and default-private matters never touch the external embedding API.

Not yet: OCR (scans are flagged `needs_ocr`), jurisdiction/date detection and authority ranking (Phase 4),
citation/quote validation (Phase 4), contract review, backups.

## Local development
```bash
docker compose up -d db                       # pgvector Postgres on :5442
py -3.12 -m venv .venv && .venv/Scripts/pip install -e "apps/api[dev]"
cp .env.example .env                          # fill SESSION_SECRET, GPU_NODE_TOKEN, models
cd apps/api && ../../.venv/Scripts/alembic upgrade head
../../.venv/Scripts/uvicorn legalai.main:app --reload
```
Tests: `cd apps/api && pytest` (needs the compose DB; creates `legalai_test`) and `cd services/gpu-gateway && pytest`.

## Deploy
- Railway: `docs/railway.md`
- Windows GPU node: `docs/gpu-node-windows.md`
