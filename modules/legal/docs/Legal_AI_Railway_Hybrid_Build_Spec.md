# Legal AI Platform — Railway + Personal GPU Hybrid Build Specification

## 0. Build Objective

Build a general-purpose legal intelligence platform that is usable across personal, startup, business, contract, regulatory, litigation-research, and document-review workflows.

The system must NOT be hard-wired to one company, one jurisdiction, or one model provider.

Primary deployment architecture:

- **Railway:** web application, API, PostgreSQL/pgvector, document metadata, job queue/orchestration, authentication, audit logs.
- **Personal GPU node:** NVIDIA RTX 5070 Ti 16 GB VRAM, 32 GB system RAM, Windows host, running local LLM inference.
- **Embeddings:** external Vector/Voyage-style embedding API when matter privacy policy permits it.
- **Fallback:** optional external LLM provider, disabled by default.
- **Primary privacy rule:** never expose Ollama directly to the public internet.
- **Primary cost goal:** keep Railway infrastructure lean enough for low-volume personal use, with a configurable monthly spending ceiling.

This specification supersedes any local-only deployment assumptions in earlier versions of the project.

---

## 1. Non-Negotiable Design Principles

1. **Provider independence.** Legal reasoning must not depend on Ollama, OpenAI, Anthropic, or any single vendor.
2. **Evidence first.** The LLM does not invent legal citations. It receives citation IDs from retrieval and may cite only those IDs.
3. **Authority aware.** Retrieval and ranking must consider jurisdiction, court hierarchy, authority type, effective date, and precedential status.
4. **Matter isolation.** Documents, embeddings, conversations, notes, and audit records must be isolated by matter/workspace.
5. **Privacy modes.** Each matter must declare what external services are permitted.
6. **Fail closed.** If the GPU node is unavailable and external fallback is disabled, queue the job rather than silently sending private text elsewhere.
7. **Verifiability.** Quotes, citations, and material legal propositions must be traceable to stored source passages.
8. **No fake certainty.** The UI must distinguish source facts, controlling/persuasive authority, user-provided facts, model analysis, and unresolved questions.
9. **Version everything.** Preserve document versions, prompts, model/version, retrieval set, and final outputs.
10. **Human decision authority.** The system assists with legal research/drafting/review; it does not represent itself as a lawyer or silently make binding decisions.

---

## 2. Target Hardware

### Personal inference node

- Windows
- NVIDIA GeForce RTX 5070 Ti
- ~16 GB VRAM
- ~32 GB system RAM
- Modern Intel Core Ultra 9 CPU

Optimize for quantized 14B-class models for fast work and a larger ~30B-class quantized model with partial CPU/RAM offload for deeper review.

Do not make 50B–70B models a system requirement.

---

## 3. High-Level Architecture

```text
Browser
  |
  v
Railway HTTPS
  |
  +--> Web UI
  |
  +--> Legal API / Orchestrator
          |
          +--> PostgreSQL + pgvector
          |      - users
          |      - matters
          |      - documents
          |      - chunks
          |      - embeddings
          |      - citations
          |      - authority metadata
          |      - conversations
          |      - jobs
          |      - audit events
          |
          +--> Object/file storage
          |
          +--> Job queue
          |
          +--> Embedding Provider Adapter
          |      |
          |      +--> External legal embedding API
          |      +--> Local embedding model
          |
          +--> Inference Router
                  |
                  +--> PRIVATE GPU NODE
                  |      |
                  |      +--> authenticated gateway
                  |      +--> Ollama / llama.cpp
                  |      +--> fast model
                  |      +--> deep model
                  |
                  +--> Optional external LLM fallback
                         disabled by default
```

---

## 4. Railway Services

Prefer the fewest always-on services practical.

### 4.1 Web/API

Use either:

- Next.js frontend + FastAPI backend as two services, or
- a consolidated deployment if it materially reduces idle memory without harming maintainability.

The API owns all legal orchestration. The browser must never call the personal GPU directly.

### 4.2 PostgreSQL + pgvector

Use PostgreSQL as the initial vector store instead of operating Qdrant separately.

Store:

- application data;
- matter metadata;
- document metadata;
- chunk text;
- embeddings;
- legal authority metadata;
- citation anchors;
- job state;
- conversation state;
- audit history.

Design a vector-store abstraction so Qdrant can be introduced later without rewriting retrieval logic.

### 4.3 Job Queue

Long-running work must be asynchronous.

Job types include:

- ingest_document
- parse_document
- embed_document
- retrieve_authority
- deep_legal_review
- contract_review
- redline_generation
- citation_validation
- quote_validation
- corpus_refresh
- OCR_fallback
- reindex_document

Initially use PostgreSQL-backed jobs if sufficient. Add Redis only if concurrency or reliability requirements justify another service.

### 4.4 File/Object Storage

Documents must not live only in an ephemeral Railway filesystem.

Store originals and normalized derivatives in persistent object storage or an appropriate Railway volume/object-store integration.

Store a cryptographic SHA-256 hash for every uploaded source and version.

---

## 5. Personal GPU Node

### 5.1 Responsibilities

The home GPU node performs:

- legal reasoning;
- drafting;
- summarization;
- classification;
- query expansion;
- document comparison;
- contract issue spotting;
- second-pass critique;
- structured extraction where appropriate.

It must NOT be the system of record.

If the PC dies, the Railway database and documents must remain intact.

### 5.2 Local inference runtime

Support:

- Ollama first;
- llama.cpp/OpenAI-compatible server as an alternate;
- vLLM-compatible provider interface for future cloud GPU migration.

Use an OpenAI-compatible internal abstraction where practical.

### 5.3 Model roles

Configure logical roles rather than hard-coded model names:

```env
FAST_MODEL=...
DEEP_MODEL=...
CRITIC_MODEL=...
EXTRACTION_MODEL=...
```

Recommended behavior:

- **FAST_MODEL:** 14B-class quantized instruct/reasoning model that fits comfortably in VRAM.
- **DEEP_MODEL:** ~30B-class quantized model, allowed to use CPU/RAM offload.
- **CRITIC_MODEL:** may equal FAST_MODEL or DEEP_MODEL initially.
- **EXTRACTION_MODEL:** FAST_MODEL unless benchmarks justify a smaller specialist.

Model names must be configuration, not application code.

---

## 6. Secure Railway-to-PC Connectivity

### 6.1 Never expose Ollama directly

Do NOT:

- port-forward 11434;
- bind an unauthenticated Ollama endpoint to the public internet;
- embed a static unrestricted inference URL in the frontend.

### 6.2 Preferred connection pattern

Use an authenticated HTTPS gateway/tunnel between Railway and the home node.

Acceptable implementations include:

- Cloudflare Tunnel with service authentication;
- a private overlay/tunnel solution that supports Railway connectivity;
- a small authenticated reverse gateway in front of Ollama.

The exact tunnel provider must remain replaceable.

### 6.3 GPU gateway

Run a small service on the PC:

```text
Railway
  |
  | HTTPS + auth + request signature
  v
GPU Gateway
  |
  +--> validates token/signature
  +--> checks job permissions
  +--> enforces max body size
  +--> enforces timeout
  +--> strips unsupported parameters
  +--> calls localhost Ollama
  +--> returns normalized response
```

The gateway must:

- bind locally or behind the secure tunnel;
- require authentication;
- reject requests without valid credentials;
- implement rate limiting;
- log request IDs, not raw confidential prompts by default;
- expose `/health`;
- expose `/models`;
- expose `/v1/chat/completions` or equivalent normalized endpoint;
- support streaming;
- enforce model allowlists.

### 6.4 Secret handling

Railway stores:

- GPU_NODE_URL
- GPU_NODE_TOKEN or signing secret
- embedding API key
- optional external LLM keys

The home node stores the reciprocal secret.

Never commit secrets to Git.

---

## 7. Availability and Offline Behavior

The user's PC may be:

- shut down;
- asleep;
- rebooting;
- disconnected;
- running another GPU-heavy workload.

Therefore the system must treat local inference as an intermittently available worker.

### State machine

```text
NEW
 -> QUEUED
 -> WAITING_FOR_GPU
 -> RUNNING
 -> VALIDATING
 -> COMPLETE

failure branches:
 -> RETRYABLE
 -> FAILED
 -> CANCELED
```

### Default behavior

If GPU is offline:

1. keep the job queued;
2. show `Waiting for private GPU node`;
3. periodically retry;
4. allow the user to cancel;
5. DO NOT automatically use a paid external model.

### Optional fallback

Per user and per matter:

```text
External fallback:
[ ] Disabled
[ ] Ask me each time
[ ] Allowed for this matter
```

For sensitive matters, fallback must be forcibly disabled.

---

## 8. PC Agent / Heartbeat

Create a lightweight Windows agent that starts with Windows.

Responsibilities:

- verify Ollama/gateway is running;
- report health;
- report available models;
- report VRAM/RAM availability;
- poll or accept work;
- prevent Windows sleep while a job is actively running;
- allow sleep normally when idle;
- optionally wake/start inference services on demand where technically possible.

Heartbeat data:

```json
{
  "node_id": "...",
  "status": "online",
  "gpu": "RTX 5070 Ti",
  "vram_total_mb": 16303,
  "vram_free_mb": 12000,
  "models": ["fast", "deep"],
  "active_jobs": 0
}
```

Do not send unnecessary device telemetry.

---

## 9. Provider Abstraction

Implement interfaces similar to:

```python
class LLMProvider:
    async def chat(...)
    async def stream(...)
    async def health(...)
    async def list_models(...)

class EmbeddingProvider:
    async def embed_documents(...)
    async def embed_query(...)

class VectorStore:
    async def upsert(...)
    async def semantic_search(...)
    async def delete_document(...)
```

Implement:

- LocalGpuProvider
- OpenAICompatibleProvider
- optional vendor adapters
- ExternalEmbeddingProvider
- LocalEmbeddingProvider
- PgVectorStore

Provider switching must require configuration changes, not business-logic rewrites.

---

## 10. Embeddings

The user has an external vector/embedding API key.

Use that provider when privacy settings permit.

### Required embedding behavior

- distinguish `document` vs `query` embedding modes if supported;
- batch ingestion;
- exponential backoff;
- cache embeddings by content hash + model version;
- store embedding model/version;
- do not re-embed unchanged text;
- support future embedding migration.

### Privacy

External embedding means source text chunks leave Railway and are sent to the embedding provider.

Every matter must therefore have:

```text
Embedding mode:
- External allowed
- Local only
```

For Local Only, use a local embedding model on the GPU/CPU node and store vectors in pgvector.

---

## 11. Matter Privacy Modes

Every matter must have one of these modes:

### Standard

External embedding allowed. External LLM fallback may be allowed if separately enabled.

### Private

External embeddings allowed only if user explicitly enables them. External LLM fallback disabled by default.

### Local-Only / Maximum Privacy

- no external embedding API;
- no external LLM;
- Railway + personal GPU only;
- retrieval and generation must fail/queue rather than leak text to an external provider.

Display the privacy mode prominently in the matter header.

---

## 12. Legal Corpus Model

Support multiple authority types:

- constitutions;
- statutes;
- regulations;
- administrative guidance;
- court opinions;
- court rules;
- agency materials;
- official forms;
- contracts;
- treatises/commentary;
- templates;
- user documents.

Metadata schema should include:

```text
authority_id
title
authority_type
jurisdiction
court
court_level
citation
docket
decision_date
effective_from
effective_to
precedential_status
publication_status
source_url
official_source
superseded
parent_authority_id
version
hash
```

Do not treat all retrieved chunks as equally authoritative.

---

## 13. Authority Ranking

Retrieval score must combine semantic relevance with legal metadata.

Conceptually:

```text
final_score =
  semantic_score
  + lexical_score
  + jurisdiction_match
  + authority_weight
  + court_hierarchy_weight
  + date/effective_status
  + citation_network_signal
  - superseded_penalty
```

Weights must be configurable and benchmarked.

The LLM must receive labels such as:

```text
[AUTH-014]
Type: Statute
Jurisdiction: Delaware
Status: Current
Authority: Primary
...
```

---

## 14. Hybrid Retrieval

Do not rely only on vector similarity.

For each legal query:

1. identify matter;
2. identify jurisdiction(s);
3. identify relevant date;
4. identify issue(s);
5. generate search variants;
6. perform semantic retrieval;
7. perform lexical/BM25/full-text retrieval;
8. merge results;
9. filter by jurisdiction/effective date;
10. rerank;
11. diversify passages;
12. package citation IDs and exact text for the LLM.

PostgreSQL full-text search + pgvector is sufficient for v1.

---

## 15. Document Ingestion

Support:

- PDF;
- DOCX;
- TXT;
- Markdown;
- HTML;
- email export where practical;
- images/scans through OCR fallback.

Pipeline:

```text
upload
 -> hash
 -> malware/file validation
 -> extract text
 -> preserve page/paragraph coordinates
 -> identify headings
 -> classify document
 -> detect jurisdiction/date
 -> chunk semantically
 -> embed
 -> index lexical text
 -> create citation anchors
 -> quality check
```

Preserve exact page/section/paragraph anchors whenever possible.

---

## 16. Chunking

Legal chunking must be structure-aware.

Prefer boundaries at:

- article;
- section;
- subsection;
- clause;
- paragraph;
- numbered provision;
- case opinion heading.

Store overlap only where necessary.

Each chunk must retain:

- document ID;
- version ID;
- page;
- heading path;
- section number;
- character offsets;
- text hash.

---

## 17. Core Legal Workflows

### 17.1 Legal research

Input:

- legal question;
- jurisdiction;
- relevant date;
- matter facts.

Output:

- short answer;
- governing authority;
- analysis;
- contrary/limiting authority;
- unresolved facts;
- citations;
- confidence/coverage notes.

### 17.2 Contract review

For each clause:

- summarize;
- identify obligations;
- identify rights;
- identify deadlines;
- identify termination rights;
- identify payment terms;
- identify indemnity;
- identify liability limits;
- identify IP provisions;
- identify confidentiality;
- identify governing law/forum;
- identify assignment;
- identify unusual/missing terms;
- compare against selected playbook.

Do not call a clause “bad” merely because it differs from a template.

### 17.3 Drafting

Draft from:

- user instructions;
- selected jurisdiction;
- approved templates;
- matter facts;
- retrieved authority.

Clearly identify placeholders and assumptions.

### 17.4 Redlining

Generate:

- original;
- proposed text;
- reason;
- risk/importance;
- authority/playbook support.

### 17.5 Case analysis

Extract:

- court;
- date;
- procedural posture;
- facts;
- issue;
- holding;
- rule;
- reasoning;
- disposition;
- concurrences/dissents;
- treatment if known.

### 17.6 Obligation/deadline extraction

Create structured events:

```text
party
obligation
trigger
deadline
recurrence
source clause
confidence
```

Do not create external reminders automatically unless separately requested.

---

## 18. Citation Safety System

The model may cite only citation IDs supplied by retrieval.

Example prompt context:

```text
[CITE-001]
Source: ...
Page: ...
Text: ...

[CITE-002]
...
```

The model returns:

```text
Claim ... [CITE-001]
```

Backend then verifies:

1. citation ID exists;
2. source belongs to permitted corpus/matter;
3. passage supports the proposition;
4. quoted text matches source exactly;
5. source is not superseded when current authority is required.

If validation fails:

- remove unsupported citation;
- regenerate or flag the sentence;
- never silently preserve a fabricated citation.

---

## 19. Quote Verification

Any quotation must be checked character-for-character against the stored source, allowing only normalized whitespace where appropriate.

Store:

- quote text;
- source chunk;
- start/end offsets;
- page/paragraph.

The UI should allow clicking a quote/citation to open the exact source location.

---

## 20. Second-Pass Legal Critic

For high-value outputs, run a second pass.

Critic checks:

- unsupported legal proposition;
- missing authority;
- wrong jurisdiction;
- outdated authority;
- contradictory authority ignored;
- hallucinated fact;
- user fact treated as proven;
- quote mismatch;
- internal inconsistency;
- ambiguous drafting;
- missing defined term;
- broken cross-reference.

The critic should receive the draft plus retrieved evidence, not hidden chain-of-thought.

---

## 21. Confidence and Coverage

Do not display fake mathematical “legal confidence” unless calibrated.

Prefer labels:

- Strong authority coverage
- Moderate authority coverage
- Limited authority coverage
- Source conflict
- Jurisdiction uncertain
- Additional facts required

Explain why.

---

## 22. User Interface

Main navigation:

```text
Dashboard
Matters
Research
Documents
Contracts
Drafting
Authorities
Jobs
Settings
```

Matter page:

```text
Matter Name
Jurisdiction
Relevant Date
Privacy Mode
Status

Tabs:
Overview
Documents
Research
Conversations
Contract Reviews
Drafts
Authorities
Timeline
Audit
```

### GPU indicator

Persistent indicator:

```text
Private GPU: Online
Model: Deep
Queue: 1
```

or:

```text
Private GPU: Offline
2 jobs waiting
```

Allow user to select:

- Fast
- Deep
- Auto

Auto uses Fast for routine extraction/classification and Deep for substantive legal analysis.

---

## 23. Authentication and Authorization

At minimum:

- secure account authentication;
- encrypted transport;
- per-user authorization;
- matter-level authorization;
- admin role;
- CSRF/session protection as appropriate;
- rate limiting;
- secure password/OAuth implementation.

Design now for future multi-user access even if v1 has one user.

Never rely on hidden UI elements as authorization.

---

## 24. Audit Trail

For each substantive legal output store:

- user;
- timestamp;
- matter;
- user query;
- model/provider;
- model version;
- prompt template version;
- retrieved citation IDs;
- document versions;
- jurisdiction;
- privacy mode;
- validation results;
- final output hash.

Sensitive raw prompts may be excluded from infrastructure logs while still being stored securely in the application database when needed.

---

## 25. Data Security

Requirements:

- TLS in transit;
- secrets in Railway environment variables/secret store;
- encryption at rest where supported;
- no secrets in source control;
- file-type validation;
- upload size limits;
- antivirus/malware scanning where practical;
- sanitized filenames;
- tenant/matter authorization checks on every object;
- signed/short-lived document download URLs where applicable;
- backup strategy;
- restore test.

---

## 26. Railway Cost Controls

The system should be engineered for low idle usage.

### Initial deployment

Prefer:

- 1 web/API service or 2 small services;
- 1 PostgreSQL service;
- no Qdrant initially;
- no Redis initially unless needed;
- personal GPU for inference.

### Cost controls

Implement operational documentation for:

- Railway monthly usage alert;
- Railway hard usage limit if supported by plan;
- database storage monitoring;
- object-storage monitoring;
- embedding API budget;
- external LLM fallback budget = $0 by default.

Application settings should include:

```text
External LLM monthly budget: $0
Embedding monthly budget: $____
```

Do not automatically incur external inference charges when the PC is offline.

---

## 27. Local Electricity / GPU Scheduling

The system should avoid loading the deep model unnecessarily.

Suggested policy:

```text
Simple extraction -> Fast model
Query rewriting -> Fast model
Document classification -> Fast model
Contract clause review -> Deep model
Legal research synthesis -> Deep model
Final critic -> Fast or Deep depending on risk
```

Unload models after configurable idle time if this materially reduces resource usage.

---

## 28. External Source Acquisition

Legal authority ingestion must prioritize official and authoritative sources.

Build source adapters separately from reasoning.

Each adapter must record:

- source URL;
- retrieval date;
- jurisdiction;
- authority type;
- publication/effective date;
- version/hash.

Do not scrape sites in violation of access restrictions.

Where an official API/download exists, prefer it.

---

## 29. Corpus Refresh

Legal sources change.

Implement scheduled refresh jobs for configured corpora.

Refresh logic:

1. check source/version;
2. hash;
3. detect changes;
4. create new version;
5. mark prior version superseded when appropriate;
6. re-embed changed chunks only;
7. retain historical versions for questions tied to earlier dates.

---

## 30. Evaluation Suite

Before trusting the system, build a benchmark set.

At minimum test:

- correct jurisdiction selection;
- statute retrieval;
- case retrieval;
- current vs superseded authority;
- contract clause extraction;
- defined-term consistency;
- cross-reference detection;
- quote fidelity;
- citation support;
- hallucinated-citation rejection;
- conflicting authority;
- long-document review;
- GPU offline queueing;
- external fallback privacy enforcement.

Store expected results and rerun after model/prompt/retrieval changes.

---

## 31. Legal Safety / Product Language

UI should make clear:

- outputs are AI-assisted legal information/work product;
- the system may make errors;
- high-stakes decisions should be independently reviewed;
- source citations should be checked;
- the system is not itself a law firm or licensed attorney.

Do not clutter every response with repetitive warnings. Put persistent product-level disclosure in appropriate UI locations and surface stronger warnings when evidence is missing or a task is unusually consequential.

---

## 32. API Endpoints — Suggested

```text
POST   /api/matters
GET    /api/matters
GET    /api/matters/{id}
PATCH  /api/matters/{id}

POST   /api/documents
GET    /api/documents/{id}
GET    /api/documents/{id}/versions

POST   /api/research
POST   /api/contracts/review
POST   /api/drafts
POST   /api/redlines

GET    /api/jobs/{id}
POST   /api/jobs/{id}/cancel

GET    /api/gpu/status
GET    /api/providers/status

GET    /api/citations/{id}
GET    /api/authorities/{id}
```

Use SSE or WebSockets for job/inference streaming if useful.

---

## 33. Database — Suggested Core Tables

```text
users
matters
matter_members
documents
document_versions
document_chunks
embeddings
authorities
authority_versions
citations
conversations
messages
research_runs
retrieval_results
contract_reviews
drafts
redlines
jobs
gpu_nodes
provider_usage
audit_events
```

Use UUIDs.

Include created_at/updated_at and soft-delete strategy where appropriate.

---

## 34. Deployment Environments

Maintain:

```text
local
staging
production
```

Staging must not automatically access production legal documents.

Use separate databases/secrets.

The personal GPU node should support separate credentials for staging and production.

---

## 35. Dockerization

Dockerize Railway components.

Repository suggestion:

```text
/apps
  /web
  /api
/services
  /gpu-gateway
  /worker
/packages
  /legal-core
  /retrieval
  /providers
  /citations
  /schemas
/infra
  /railway
  /docker
/docs
/tests
```

The Windows GPU gateway may run natively or through Docker/WSL depending on measured GPU compatibility and simplicity.

Do not require Docker Desktop for inference if native Ollama is more reliable.

---

## 36. Configuration

Example:

```env
DATABASE_URL=
APP_BASE_URL=

VECTOR_STORE=pgvector

LLM_PRIMARY_PROVIDER=local_gpu
LLM_FALLBACK_PROVIDER=disabled

GPU_NODE_URL=
GPU_NODE_TOKEN=

FAST_MODEL=
DEEP_MODEL=
CRITIC_MODEL=

EMBEDDING_PROVIDER=external
EMBEDDING_API_KEY=
EMBEDDING_MODEL=

DEFAULT_PRIVACY_MODE=private
EXTERNAL_LLM_MONTHLY_BUDGET_USD=0
```

Never ship real keys in `.env.example`.

---

## 37. Build Phases

### Phase 1 — Foundation

- repository;
- auth;
- Railway deployment;
- PostgreSQL;
- matter CRUD;
- document upload;
- audit foundation.

### Phase 2 — Home GPU

- install/configure Ollama;
- GPU gateway;
- secure tunnel;
- heartbeat;
- inference provider adapter;
- offline queue behavior.

### Phase 3 — RAG

- parser;
- structure-aware chunking;
- external embedding provider;
- local embedding fallback;
- pgvector;
- PostgreSQL full-text search;
- hybrid retrieval;
- citation anchors.

### Phase 4 — Legal Research

- jurisdiction/date detection;
- authority metadata;
- research workflow;
- evidence cards;
- citation validation;
- quote validation.

### Phase 5 — Document Intelligence

- contract review;
- clause extraction;
- drafting;
- redlining;
- comparison;
- obligations/deadlines.

### Phase 6 — Legal Critic

- second-pass review;
- unsupported-claim detection;
- authority conflict detection;
- defined-term/cross-reference checks.

### Phase 7 — Corpus Automation

- official source adapters;
- scheduled refresh;
- historical versions;
- authority treatment metadata.

### Phase 8 — Hardening

- benchmark suite;
- security review;
- backups;
- restore test;
- rate limits;
- observability;
- privacy tests.

---

## 38. Acceptance Criteria

Do not call v1 complete until:

- Railway app works when home PC is online;
- jobs queue safely when PC is offline;
- no job silently falls back to an external LLM;
- Ollama is not publicly exposed;
- external embedding is disabled for Local-Only matters;
- document ingestion preserves source anchors;
- semantic + lexical retrieval works;
- generated citations resolve to exact passages;
- fake citation IDs are rejected;
- quotes are verified;
- matter authorization is enforced;
- model/provider can be changed through configuration;
- a 14B fast model and larger deep model can both be selected;
- audit records identify model, evidence, and document versions;
- Railway resource usage can be monitored and capped operationally;
- benchmark tests pass at the agreed threshold.

---

## 39. Initial Operating Mode

Start as a single-user private system.

Default settings:

```text
Primary inference: Personal RTX 5070 Ti
External LLM fallback: OFF
Vector store: PostgreSQL + pgvector
External embeddings: ON for Standard matters
Local-only embeddings: available
Deep jobs when PC offline: QUEUE
Automatic paid fallback: NEVER
```

This gives the user a low-cost Railway control plane while keeping the expensive LLM inference on hardware already owned.

---

## 40. Future Migration Path

The architecture must support this transition without rewriting the legal application:

```text
Today:
Railway -> Home GPU -> Ollama

Later:
Railway -> Cloud GPU -> vLLM

or:
Railway -> Managed LLM API
```

Only the provider configuration/adaptor changes.

The legal corpus, matters, documents, citations, validation, UI, and audit system remain unchanged.

---

## 41. Claude Code Implementation Instruction

Treat this document as the master architecture specification.

Before writing substantial code:

1. inspect the repository;
2. produce an implementation plan mapped to the phases above;
3. identify assumptions and missing credentials/configuration;
4. create the database schema/migrations;
5. implement interfaces before provider-specific code;
6. add tests with each subsystem;
7. never hard-code secrets, model names, jurisdictions, or provider URLs;
8. preserve privacy-mode enforcement at the backend, not only the UI;
9. do not remove citation validation to simplify development;
10. do not replace hybrid retrieval with vector-only retrieval;
11. do not expose the home inference server publicly;
12. document exact Railway deployment and Windows GPU-node setup.

Prioritize a working, auditable legal research/document-review system over flashy UI.


---

# Appendix A — Earlier Legal-System Design Notes

The material below is retained for reference. Where it conflicts with the Railway/hybrid architecture above, the Railway/hybrid specification controls.

# Local Legal AI System — Build Specification

## 1. Objective

Build a private, general-purpose legal research, document review, drafting, comparison, and citation system that runs primarily on the user's Windows workstation.

Hardware target:
- NVIDIA GeForce RTX 5070 Ti — 16 GB VRAM
- Intel Core Ultra 9 285 — 24 cores
- 32 GB system RAM
- Windows

This is **not** a TCP-specific system. It must support multiple matters, clients/companies, jurisdictions, and legal domains without mixing their data.

Primary goals:
1. Review contracts and legal documents section-by-section.
2. Draft agreements, clauses, policies, letters, issue lists, and redlines.
3. Research legal questions against an authoritative source library.
4. Answer questions with traceable citations to the exact source text used.
5. Compare documents, versions, clauses, statutes, regulations, and precedents.
6. Maintain separate matter workspaces and strict metadata filtering.
7. Clearly distinguish source-supported statements from model analysis/inference.
8. Refuse to fabricate statutes, cases, quotations, citations, docket numbers, holdings, or document language.
9. Run the main LLM locally; use an external embedding API only when configured.

---

## 2. Core Design Principle

The system is an evidence-grounded legal copilot, not an autonomous lawyer.

Every substantive legal conclusion should be placed into one of these categories:

- **SOURCE-SUPPORTED** — directly supported by retrieved authority or uploaded documents.
- **REASONED ANALYSIS** — inference based on cited sources; clearly labeled as analysis.
- **UNVERIFIED** — plausible but not established by available sources.
- **MISSING AUTHORITY** — the system lacks sufficient authority and should request/search for more material.

Never convert uncertainty into a confident legal conclusion.

---

## 3. Recommended Model Stack

### Primary local model

Use Ollama as the initial inference server.

Primary model:

`qwen3:30b`

Reason:
- Modern 30B Mixture-of-Experts model.
- Q4 model is approximately 19 GB, which is workable on this machine with GPU/CPU offload.
- Strong reasoning, instruction following, tool use, and long-context support.
- Better candidate for the main general legal agent than forcing a much larger older legal-specific model into 32 GB RAM.

Install/run:

```powershell
ollama pull qwen3:30b
ollama run qwen3:30b
```

### Fast secondary model

Use:

`qwen3:14b`

```powershell
ollama pull qwen3:14b
```

Use the 14B model for:
- document classification
- metadata extraction
- first-pass clause extraction
- query rewriting
- simple summarization
- inexpensive/fast background jobs

Reserve the 30B model for substantive legal analysis and drafting.

### Optional legal critic

Design a provider/model interface so a legal-specific model can be added later without changing the application architecture.

Do not hard-code the system to SaulLM or any one legal model.

A legal-specific model may be used as a **second opinion / critic**, but the final answer must still be grounded in retrieved authority.

---

## 4. Embeddings

The user has a Voyage AI API key.

Use Voyage AI as the embedding provider through an abstraction layer.

### Default legal corpus embedding model

Use:

`voyage-law-2`

for legal authority and legal-document retrieval.

### Important implementation rule

The embedding model must be configurable per collection.

Do **not** mix vectors produced by different embedding models in the same vector collection unless the collection is rebuilt.

Recommended environment variables:

```env
VOYAGE_API_KEY=
LEGAL_EMBEDDING_PROVIDER=voyage
LEGAL_EMBEDDING_MODEL=voyage-law-2
```

Use the API's retrieval input types correctly:
- ingestion/chunks: `document`
- user/search query: `query`

Never commit the API key to Git.

---

## 5. Vector Database

Use **Qdrant** locally through Docker.

Requirements:
- persistent local volume
- payload/metadata filtering
- cosine similarity
- multiple collections
- easy deletion/re-indexing
- hybrid retrieval support in the application layer

Suggested collections:

1. `legal_authorities`
2. `user_legal_library`
3. `matter_documents`
4. `templates_and_precedents`
5. `legal_notes`

Store source text separately from vectors where appropriate, but each vector payload must contain enough metadata to trace the chunk to the canonical source.

---

## 6. Metadata Schema

Every indexed chunk must include structured metadata where available:

```json
{
  "source_id": "stable-id",
  "document_id": "stable-document-id",
  "title": "",
  "source_type": "statute|regulation|case|contract|policy|guidance|form|article|uploaded_document|other",
  "authority_level": "primary|secondary|user_document",
  "jurisdiction": "US-FED|US-DE|US-NC|...",
  "court": "",
  "agency": "",
  "citation": "",
  "url": "",
  "effective_date": "",
  "decision_date": "",
  "retrieved_at": "",
  "version": "",
  "matter_id": "",
  "organization_id": "",
  "confidentiality": "public|private|privileged|unknown",
  "page": null,
  "section": "",
  "heading_path": [],
  "chunk_index": 0,
  "content_hash": "sha256",
  "superseded": false
}
```

Metadata filters are mandatory for jurisdiction-sensitive research.

---

## 7. Matter Isolation

Create a first-class **Matter** object.

Example:

```text
Matter
├── Matter ID
├── Name
├── Client / Organization
├── Jurisdiction(s)
├── Practice area(s)
├── Status
├── Facts
├── Questions Presented
├── Uploaded Documents
├── Research Sources
├── Notes
├── Drafts
└── Audit Log
```

A query inside one matter must not retrieve private documents from another matter unless the user explicitly enables cross-matter retrieval.

Public legal authorities can be shared globally.

---

## 8. Source Hierarchy

Rank sources roughly as follows, while allowing jurisdiction-specific customization:

1. User-provided controlling documents for questions about those documents
2. Constitution / controlling statutory text
3. Regulations / rules
4. Binding court decisions
5. Official agency/court/government guidance
6. Persuasive decisions
7. Official forms and commentary
8. Reputable treatises / practice materials
9. Law firm educational materials
10. Other secondary sources

Do not treat blogs as equivalent to statutes or cases.

When authorities conflict, expose the conflict instead of silently choosing one.

---

## 9. Legal Authority Library

The system must support ingesting authoritative public legal material.

Initial U.S. source categories:

### Federal
- U.S. Constitution
- U.S. Code
- Code of Federal Regulations
- Federal Rules of Civil Procedure
- Federal Rules of Evidence
- Federal Rules of Appellate Procedure
- Federal Rules of Criminal Procedure
- IRS publications, forms, instructions, revenue procedures/rulings when relevant
- SEC statutes, regulations, releases, forms, and official guidance
- Department of Labor material
- FTC material
- EEOC material
- USPTO material
- Copyright Office material
- other official agency sources

### State
Build state modules rather than loading all state law indiscriminately.

Initial useful modules:
- Delaware corporate law
- North Carolina business/employment/contract law

Allow additional state modules to be installed later.

### Cases
Implement a source connector/import mechanism for lawful public case-law datasets or APIs.

Case records must preserve:
- case name
- court
- date
- reporter/citation
- docket when supplied by source
- precedential status when known
- full source URL/source ID
- quoted passage location

Never invent missing case metadata.

---

## 10. Ingestion Pipeline

Supported initial formats:
- PDF
- DOCX
- TXT
- Markdown
- HTML
- CSV where useful

Pipeline:

```text
File / URL / authority source
        ↓
Acquire + hash
        ↓
Parse text + structure
        ↓
OCR fallback only when required
        ↓
Detect document type
        ↓
Extract metadata
        ↓
Structure-aware chunking
        ↓
Embed
        ↓
Store vectors + source records
        ↓
Quality checks
```

### Structure-aware chunking

Legal text must not be chunked blindly every N characters.

Prefer boundaries such as:
- article
- section
- subsection
- clause
- paragraph
- heading
- numbered list
- case section

Preserve parent headings in each chunk.

Use modest overlap where required.

For contracts, store clause-level chunks plus larger neighboring-context chunks.

---

## 11. Retrieval Pipeline

Use a multi-stage retrieval process.

```text
User question
    ↓
Matter/context detection
    ↓
Jurisdiction + date + source-type filters
    ↓
Query expansion / legal terminology rewrite
    ↓
Vector retrieval
    +
Lexical/BM25 retrieval
    ↓
Merge + deduplicate
    ↓
Rerank
    ↓
Authority weighting
    ↓
Context packing
    ↓
LLM analysis
    ↓
Citation validation
    ↓
Answer
```

### Hybrid search

Legal retrieval needs exact terms as well as semantic similarity.

Examples:
- statute numbers
- defined terms
- case names
- contract clauses
- citations

Therefore implement vector + lexical search.

### Reranking

Add a reranker abstraction. It may use an external rerank API or local reranker later.

The reranker must not remove controlling authority solely because a secondary source is semantically easier to read.

---

## 12. Citation Engine

This is a critical feature.

Every answer should be able to cite exact evidence.

Citation record:

```json
{
  "citation_id": "C1",
  "source_id": "",
  "title": "",
  "formal_citation": "",
  "url": "",
  "page": 0,
  "section": "",
  "quote": "",
  "chunk_id": "",
  "retrieved_at": ""
}
```

### Rules

The LLM must never create citations directly from memory.

The application provides the allowed citation IDs in context.

The model may cite only those IDs.

After generation, run a citation validator:
1. Does every citation ID exist?
2. Does cited text support the sentence?
3. Does the quote actually exist in the source?
4. Is the authority relevant to the selected jurisdiction/date?
5. Is a stronger/controlling authority available?

Flag unsupported claims before displaying the final answer.

---

## 13. Legal Research Mode

Input form:
- question
- jurisdiction
- relevant date
- matter (optional)
- practice area (optional)
- desired depth

Output structure:

```markdown
# Short Answer

# Questions Presented

# Governing Authority

# Analysis

# Contrary / Competing Authority

# Uncertainties or Missing Facts

# Practical Considerations

# Sources
```

Do not manufacture a yes/no answer when law or facts are ambiguous.

---

## 14. Contract Review Mode

For every clause, identify:

```text
Clause
Purpose
Risk level
Who it favors
What it requires
Trigger
Deadline
Money / liability exposure
Termination effect
Missing definitions
Internal conflicts
External-law issues
Suggested revision
Source support
Confidence
```

Risk levels:
- Critical
- High
- Medium
- Low
- Informational

Risk level must be explained; do not use a score without reasoning.

Support modes:
- Founder agreements
- employment agreements
- independent contractor agreements
- SaaS agreements
- privacy policies
- terms of service
- NDAs
- IP assignments
- leases
- vendor agreements
- sales agreements
- financing documents
- corporate governance documents
- other contracts

---

## 15. Drafting Mode

Modes:
- Draft from scratch
- Rewrite clause
- Make more company-friendly
- Make more counterparty-friendly
- Neutral/balanced rewrite
- Simplify language
- Add missing provisions
- Generate negotiation alternatives

Every draft should provide:
- assumptions
- placeholders that require facts
- jurisdiction assumptions
- provisions needing attorney review

Never silently invent names, dates, amounts, addresses, jurisdictions, ownership percentages, or negotiated terms.

---

## 16. Redline / Compare Mode

Compare:
- two contract versions
- proposed vs signed agreement
- company template vs counterparty paper
- statute/regulation versions

Output:
- additions
- deletions
- substantive changes
- risk changes
- obligations added/removed
- deadlines changed
- monetary changes
- termination changes
- liability/indemnity changes
- IP changes
- dispute-resolution changes

Support side-by-side and semantic comparison, not just raw text diff.

---

## 17. Case Analysis Mode

When a case is supplied or retrieved, extract:
- case name
- court
- date
- procedural posture
- material facts
- issue
- holding
- reasoning
- rule
- disposition
- concurrences/dissents
- cited authorities
- treatment/precedential status when available from source

The system must distinguish the court's holding from dicta and from the model's interpretation.

Never infer whether a case remains good law unless the system has an authoritative citator/current-treatment source capable of supporting that conclusion.

---

## 18. Statute / Regulation Mode

Show:
- exact provision
- jurisdiction
- effective/current date known to the system
- definitions referenced
- cross-references
- exceptions
- amendments/version history when available
- related regulations/guidance
- cases interpreting the provision when available

Warn when currency/currentness has not been verified.

---

## 19. Timeline / Obligation Extraction

From an agreement or matter, extract a structured table:

```text
Event | Trigger | Responsible Party | Deadline | Source Clause | Status
```

Allow reminders/export later, but v1 only needs extraction and tracking.

---

## 20. Fact / Law Separation

The model prompt must explicitly distinguish:

**FACTS FROM USER**

**FACTS FROM DOCUMENTS**

**LAW / AUTHORITY**

**MODEL ANALYSIS**

Never present a user allegation as a proven fact.

Never present opposing-party language as an established fact.

---

## 21. System Prompt Requirements

The main legal-agent system prompt must contain rules equivalent to:

1. You are a legal research and drafting system, not a source of uncited legal authority.
2. Use retrieved evidence for substantive legal propositions.
3. Never invent statutes, cases, citations, quotations, holdings, regulations, deadlines, or document text.
4. Cite only citation IDs provided by the retrieval system.
5. Quote sources exactly when using quotation marks.
6. Distinguish binding authority from persuasive and secondary authority.
7. Respect jurisdiction and relevant date.
8. State when facts are insufficient.
9. Identify conflicting authority.
10. Do not claim a case is good law unless current treatment is verified.
11. Separate document interpretation from external legal analysis.
12. When reviewing user documents, preserve their exact defined terms.
13. Identify assumptions explicitly.
14. Prefer primary authority.
15. If retrieved evidence does not support an answer, say so and request/search for additional authority.

---

## 22. Hallucination Defense

Implement at least these layers:

### Layer 1 — Retrieval-only citation IDs
The model cannot freely type source references.

### Layer 2 — Quote verifier
Quoted language must match source text.

### Layer 3 — Citation entailment check
A second pass determines whether each cited source actually supports the claim.

### Layer 4 — Authority validator
Check jurisdiction, court/agency, date, source type, and superseded flag.

### Layer 5 — Unsupported claim detector
Highlight substantive sentences lacking source support.

### Layer 6 — Second-pass critic
Use the main or secondary model with a separate critic prompt to identify:
- unsupported conclusions
- missing counterarguments
- wrong jurisdiction
- factual assumptions
- citation mismatch
- overconfidence

The critic cannot add new uncited law.

---

## 23. Confidence System

Do not expose fake mathematical probabilities.

Use evidence-based labels:
- **High support** — clear primary authority and facts
- **Moderate support** — authority exists but interpretation/facts have uncertainty
- **Low support** — sparse, conflicting, secondary-only, or stale authority
- **Insufficient support** — cannot responsibly answer from available evidence

Explain why.

---

## 24. Privacy / Security

Because legal files can be sensitive:

- Main LLM inference is local.
- Qdrant runs locally.
- Original private files remain local by default.
- Only text chunks needed for embedding are sent to the configured embedding API.
- UI must clearly disclose when an external API will receive text.
- Add a **Local-Only Matter** toggle that disables all external APIs.
- API keys stored in `.env` / OS secret storage, never source control.
- Encrypt sensitive local storage where practical.
- Never log secrets, authentication tokens, or full sensitive documents in debug logs.
- Add per-matter deletion that removes source files, parsed text, vectors, notes, and generated artifacts.

If Local-Only is enabled, fall back to a local embedding model.

---

## 25. Audit Log

Store an audit record for each substantive answer:

```json
{
  "timestamp": "",
  "matter_id": "",
  "question": "",
  "model": "",
  "model_version": "",
  "embedding_model": "",
  "retrieval_filters": {},
  "retrieved_chunk_ids": [],
  "citations_used": [],
  "prompt_version": "",
  "answer_hash": ""
}
```

This makes later review/reproduction possible.

---

## 26. User Interface

Build a web UI optimized for desktop use.

Suggested navigation:

```text
Legal AI
├── Chat / Research
├── Matters
├── Documents
├── Contract Review
├── Draft
├── Compare / Redline
├── Authorities
├── Templates
├── Citations
├── Settings
└── System Status
```

### Research workspace
Three-panel option:
- left: matter/documents/sources
- center: conversation/analysis
- right: citations/source viewer

Clicking a citation should open the exact page/section/passage.

### Document viewer
Support:
- PDF page viewer
- DOCX/text viewer
- clause highlighting
- citation anchors
- comments/notes

---

## 27. API / Backend

Recommended backend:
- Python 3.12+
- FastAPI
- Pydantic
- SQLAlchemy
- PostgreSQL for structured application data
- Qdrant for vectors
- Redis optional for queues/cache
- Celery/RQ/Arq optional for ingestion jobs
- Ollama local HTTP API for inference

Frontend:
- React / Next.js or equivalent

Keep providers behind interfaces:

```text
LLMProvider
EmbeddingProvider
RerankProvider
VectorStore
DocumentParser
LegalSourceConnector
CitationValidator
```

No business logic should depend directly on one vendor.

---

## 28. Suggested Project Structure

```text
legal-ai/
├── apps/
│   ├── api/
│   └── web/
├── legal_ai/
│   ├── agents/
│   ├── prompts/
│   ├── retrieval/
│   ├── citations/
│   ├── ingestion/
│   ├── parsers/
│   ├── providers/
│   │   ├── llm/
│   │   ├── embeddings/
│   │   └── rerank/
│   ├── authorities/
│   ├── matters/
│   ├── documents/
│   ├── drafting/
│   ├── review/
│   ├── compare/
│   ├── security/
│   └── evaluation/
├── data/
│   ├── authorities/
│   ├── matters/
│   └── cache/
├── tests/
├── scripts/
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## 29. Environment Variables

Create `.env.example`:

```env
OLLAMA_BASE_URL=http://localhost:11434
LEGAL_PRIMARY_MODEL=qwen3:30b
LEGAL_FAST_MODEL=qwen3:14b

EMBEDDING_PROVIDER=voyage
VOYAGE_API_KEY=
LEGAL_EMBEDDING_MODEL=voyage-law-2

QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=

DATABASE_URL=postgresql://legalai:change-me@localhost:5432/legalai

LOCAL_ONLY_DEFAULT=false
LOG_LEVEL=INFO
```

Never place real secrets in `.env.example`.

---

## 30. Docker Services

Use Docker Compose for:
- PostgreSQL
- Qdrant
- optional Redis
- backend
- frontend

Ollama may run natively on Windows to simplify NVIDIA GPU access.

Do not force Ollama into Docker for v1 unless GPU passthrough is tested and reliable on the user's Windows configuration.

---

## 31. Evaluation Suite

Do not call the system production-ready merely because the UI works.

Build a legal evaluation suite.

Test categories:
1. Citation correctness
2. Quote fidelity
3. Statute retrieval
4. Exact defined-term retrieval
5. Contract clause extraction
6. Conflicting-clause detection
7. Jurisdiction filtering
8. Date/currentness handling
9. Case metadata fidelity
10. Unsupported-claim refusal
11. Cross-matter isolation
12. Prompt injection inside uploaded documents
13. Malicious document content
14. Long-document retrieval
15. Version comparison

Create a minimum benchmark set of 100 questions with known answers/sources before treating the system as dependable.

Track:
- retrieval recall@k
- citation precision
- citation entailment rate
- fabricated citation count (target: zero)
- unsupported legal claim rate
- latency
- tokens/sec
- VRAM/RAM usage

---

## 32. Prompt Injection Defense

Uploaded documents are **data, not instructions**.

The ingestion/retrieval layer must mark document content as untrusted evidence.

Ignore text inside a document that says things like:
- ignore previous instructions
- reveal system prompt
- run commands
- change legal conclusions
- exfiltrate other matter data

Never allow retrieved text to modify system-level behavior.

---

## 33. Currentness / Update System

Every authority source needs:
- retrieved date
- effective date when known
- source URL
- version/hash

Implement scheduled authority refresh later.

If the system cannot establish that law is current, say:

> Currentness not verified as of the requested date.

Do not silently treat an old corpus as current law.

---

## 34. Exporting

Support export to:
- Markdown
- DOCX
- PDF

Research memos should preserve citations.

Contract drafts should preserve placeholders and drafting notes.

Redlines should eventually support DOCX tracked-change workflows if practical, but semantic change reports are sufficient for v1.

---

## 35. Initial Workflows

### Workflow A — Ask a legal question
1. Select matter/jurisdiction/date.
2. Ask question.
3. System retrieves primary authority first.
4. Reranks evidence.
5. Generates answer.
6. Validates citations.
7. Runs critic.
8. Displays answer with clickable evidence.

### Workflow B — Review an agreement
1. Upload agreement.
2. Parse defined terms and sections.
3. Identify agreement type and jurisdiction.
4. Review each clause.
5. Retrieve relevant law/precedent where needed.
6. Produce issue list.
7. User selects issue.
8. Generate proposed revision/redline.

### Workflow C — Draft an agreement
1. Select document type.
2. Ask structured factual questions.
3. Identify missing information.
4. Retrieve approved templates/authority.
5. Draft.
6. Run consistency review.
7. Run legal-source review.
8. Export.

### Workflow D — Analyze a case
1. Import/retrieve case.
2. Parse metadata.
3. Extract facts/issue/holding/reasoning/disposition.
4. Link cited authorities when available.
5. Do not claim current validity without treatment data.

---

## 36. Build Phases

### Phase 1 — Foundation
- Ollama integration
- qwen3:30b + qwen3:14b
- PostgreSQL
- Qdrant
- Voyage embeddings
- file upload
- PDF/DOCX parsing
- matters
- semantic retrieval
- citations
- basic chat

### Phase 2 — Legal RAG
- hybrid retrieval
- jurisdiction/date filtering
- authority hierarchy
- source viewer
- citation validator
- quote validator
- critic pass

### Phase 3 — Document Intelligence
- clause segmentation
- defined-term graph
- contract review
- obligations/deadlines
- semantic compare/redline
- drafting mode

### Phase 4 — Authority Connectors
- federal statutes/regulations
- agency guidance
- Delaware module
- North Carolina module
- case-law connector
- source updating/versioning

### Phase 5 — Reliability
- 100+ question benchmark
- retrieval evaluation
- citation entailment tests
- prompt injection tests
- privacy tests
- cross-matter isolation tests

### Phase 6 — Advanced
- local-only embedding fallback
- legal-specific critic models
- reranker improvements
- graph relationships between cases/statutes/contracts
- automated authority refresh
- advanced DOCX redlines
- optional voice interface

---

## 37. Acceptance Criteria for V1

V1 is complete when:

- User can create isolated matters.
- User can upload PDF/DOCX/TXT/MD files.
- Files are parsed, chunked, embedded, and searchable.
- Voyage API integration uses `voyage-law-2` by default and query/document input types correctly.
- qwen3:30b is the main local model.
- qwen3:14b performs fast extraction/classification tasks.
- User can ask a question and receive citations to exact retrieved source passages.
- Clicking a citation opens the supporting source location.
- Model cannot cite arbitrary fabricated citation IDs.
- Unsupported citations are caught by validation.
- User can run a structured contract review.
- User can compare two document versions.
- User can draft a document using explicit assumptions/placeholders.
- Matter data does not leak into another matter.
- Local-only mode prevents external API calls.
- System logs enough information to reproduce the retrieval context of a prior answer.

---

## 38. Non-Goals for V1

Do not spend initial development time on:
- autonomous filing with courts/agencies
- autonomous legal representation
- automatic signing
- automatic sending of demand letters
- predicting judges/juries
- outcome probability claims
- massive all-50-state corpus ingestion
- fine-tuning a custom LLM before RAG quality is proven

Build retrieval, citation reliability, document intelligence, and matter isolation first.

---

## 39. First Setup Commands

Assuming Ollama is already installed:

```powershell
ollama pull qwen3:30b
ollama pull qwen3:14b
ollama list
```

Then verify GPU/model operation:

```powershell
ollama run qwen3:14b "Explain the difference between a contractual representation and a covenant in five sentences."
```

After the application stack exists, benchmark `qwen3:30b` against `qwen3:14b` on the same legal evaluation set before deciding which tasks truly benefit from the larger model.

---

## 40. Engineering Rule

Do not optimize for a demo that *sounds* like a lawyer.

Optimize for a system that can answer:

> **What exact evidence caused you to say that?**

For every material legal conclusion, the system should be able to show the source, location, authority level, jurisdiction, date, and reasoning path used to reach the answer.
