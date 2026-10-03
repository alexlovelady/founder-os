# Legal AI Platform

Implements `Legal_AI_Railway_Hybrid_Build_Spec.md`. **Status: Phases 1–8 built.** Remaining work is operational: real-world benchmarking, OCR, malware scanning and scheduled backups.

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

- Phase 4: heuristic classification and jurisdiction/date detection on upload (user edits always win); authority
  metadata per document (type, jurisdiction, court level, effective dates, superseded) feeding authority-aware ranking;
  research workflow (query variants -> hybrid retrieval -> grounded generation) with a fixed prompt that treats
  documents as untrusted data; citation validation (fake IDs removed and reported, support checks, optional LLM
  entailment, superseded flags), verbatim quote verification with exact offsets, one automatic correction pass,
  coverage labels instead of fake confidence scores, and a full audit record per run (`research_runs`).
  If nothing relevant is retrieved the model is not called at all.

- Phase 5: contract review (clause units -> structured extraction -> deterministic checks for missing topics, undefined/unused
  defined terms and broken cross-references -> issue assessment with verified quotes), playbooks, obligation/deadline extraction
  (no reminders are created), redlines whose original text is always the stored clause, word-level diffs, clause-aligned version
  comparison with figure-change detection, and drafting with placeholders, assumptions and a list of every specific the user did
  not supply.
- Phase 6: second-pass critic whose findings are verified in code (location must exist, no new law, no unknown IDs) plus
  deterministic conflict, jurisdiction and currentness detectors.
- Phase 7: shared authority library (eCFR API and official https URLs, SSRF-safe), scheduled refresh, hashed versions with
  effective dates so questions tied to an earlier date use the text then in force, recorded treatment (never inferred),
  "currentness not verified" and "no treatment data" labels.
- Phase 8: security headers, rate limits, request IDs, admin health/metrics/users, backup + restore verification
  (`scripts/backup.py`, `docs/backup.md`), benchmark suite with regression baseline (`benchmarks/`), network-guard privacy
  tests, and a security review (`docs/security.md`).

- Limits pass: **pull-mode GPU** (your PC only makes outbound calls, no tunnel or public hostname), **TOTP MFA** with recovery codes,
  **upload scanning** (built-in checks always, ClamAV optional), **OCR** for scans (Tesseract, flagged everywhere it is used),
  **daily verified backups** plus an off-site puller, **document revision** (recreate an uploaded document with accepted
  recommendations applied, as a clean or tracked-changes Word file, or save it as a new version), U.S. Code and eCFR sources with
  one-click presets, a treatment bulk-import, and a 103-question / 7-contract retrieval benchmark measured with the real embedders.
  See `docs/legal-sources.md` for why no model training is needed.

Honest limits: ClamAV is not deployed (RAM cost); CourtListener support is mock-tested only (needs a free token); no citator data
ships with the system (you record treatment); state codes need per-state sources; the benchmark is small and was tuned on its own
questions; OCR quality depends on scan quality; backups on the server share the data volume (pull an off-site copy).

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
