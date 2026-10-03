# LegalAI module

LegalAI (`modules/legal/`) is the legal work engine of FounderOS: a separate FastAPI service with its own Postgres (pgvector) database, a React UI and its own job worker. The shell signs users in through it, proxies its UI under `/legal-ui`, and calls it server to server. Written from the code on 2026-10-03; its own README is `modules/legal/README.md`, security notes `modules/legal/docs/security.md`, sources `modules/legal/docs/legal-sources.md`, backups `modules/legal/docs/backup.md`.

**LegalAI is software, not a law firm.** Nothing it produces is legal advice, nothing creates an attorney-client relationship, and every output is meant to be checked by the user and, for anything important, by a lawyer.

## Features

| Feature | What it does | Where |
|---|---|---|
| Company workspace and checklist | `POST /api/onboarding` creates one company project per user (name, entity type, state, stage). The legal checklist ticks itself when an uploaded document is recognized as a given type. | `routers/startup.py`, `startup/catalog.py` |
| Documents | Upload (pdf, docx, txt, md, html, eml, images such as png/jpg/tiff), type and magic-byte checks, size limit, upload scanning, SHA-256, versions, authenticated download. | `routers/documents.py`, `storage.py`, `scanning.py` |
| Parsing and OCR | Parsers keep page numbers, headings and exact character offsets; Tesseract OCR for scans, flagged everywhere it is used. | `ingestion/` |
| Search | Structure-aware chunks, embeddings, pgvector plus Postgres full text fused by reciprocal rank fusion, authority-aware ranking, citation ids (`CITE-001`) and a source viewer. | `retrieval/` |
| Cited research ("Ask") | Query variants, hybrid retrieval, grounded generation, then validation (below). If nothing relevant is retrieved the model is not called. | `research/`, `citations/` |
| Contract review | Clause units, structured extraction, deterministic checks, issue assessment, plain-English summary, obligations, redline proposals. | `review/` |
| Playbooks | Built-in and user-defined rule sets (topic, preferred position, fallback, red flags, severity). Built in: balanced commercial, founders agreement, LLC operating agreement, SAFE/convertible note, contractor/IP assignment. A recognized startup document type picks its matching checklist automatically. | `review/pipeline.py`, `routers/review.py` |
| Version comparison | Clause-aligned comparison with figure-change detection and word-level diffs. | `review/diff.py`, `review/summary.py` |
| Drafting | "Create a document" from library templates and the startup catalog outlines, with `[●PLACEHOLDER]` for every fact the user did not supply; download as Word or save into the project. | `drafting/`, `startup/catalog.py` |
| Revision | Recreate an uploaded document with accepted (optionally also pending) recommendations applied: `docx` (clean), `tracked_docx` (real Word tracked changes), `txt`, `md`, or save as a new version. A change whose original text no longer matches the stored text is skipped and reported. | `drafting/revise.py`, `routers/revise.py` |
| Critic | Optional second pass over a review or research output; its findings are verified in code (the location must exist, it cannot add law or unknown ids) and complemented by deterministic conflict, jurisdiction and currentness detectors. | `critic/` |
| Legal library | Shared, read-only public authority text, fetched from official sources with version history. See below. | `corpus/`, `routers/library.py` |
| Admin | Users, health and metrics, backups, library sources. Admins get no implicit access to project content. | `routers/admin.py`, `routers/backups.py` |

Shell integration: the Document Vault can send a file to LegalAI (`/api/legalbridge/review`), which uploads it to the business's LegalAI workspace and starts a contract review. See `modules/vault/README.md`.

## How verification works (what is checked in code, and what is not)

* **Citations.** A research answer may only cite the numbered passages retrieval supplied. Invented citation ids are removed and reported, support is checked, and an optional LLM entailment pass can downgrade claims; superseded sources are flagged (`citations/validate.py`).
* **Quotes.** A quotation passes only if it appears character for character in a stored source passage. Allowed differences are runs of whitespace and typographic variants of quotes, dashes and spaces; case, wording and punctuation otherwise must match. An ellipsised quote needs every fragment, in order, in one passage (`citations/quotes.py`). A research answer gets one automatic correction pass; whatever still fails is removed or flagged.
* **Review issues.** The model can reference only clause ids that exist. An issue's quote is checked against the clause text and removed (with a warning) if it is not verbatim; an issue without a reason, or without a real clause (unless it is a missing-term issue), is dropped. At most 15 model issues are kept. Software findings (missing topics, capitalized terms never defined, defined terms never used, cross-references to something that is not in the document) are added regardless of the model.
* **Plain-English summary.** Each key term is shown as "checked" only if its exact wording is found in the cited clause (or the document); otherwise it is marked "verify".
* **Redlines.** The original text of a redline is always the stored clause, never the model's copy. Suggested replacement text is a proposal, not a source.
* **Coverage labels instead of confidence scores.** Research answers carry labels such as strong, moderate or limited authority coverage, "Jurisdiction uncertain", "Superseded or out-of-date sources retrieved", "Some sources are OCR text", "Currentness not verified as of the requested date", "No treatment data", "Additional facts required", "Some statements are not verified". There is no numeric confidence.
* **Audit record.** Each review and research run stores its inputs, model, prompt version and output hash.
* **What is not verified.** That a clause is legally enforceable; that a case is still good law (the system never infers treatment, see below); that an unquoted statement in a summary is right; or anything about law that is not in the library. Verification reduces the chance of a made-up citation or quote; it does not make the substance correct. `modules/legal/docs/security.md` says the same: validators reduce, not eliminate, the risk of misleading text.

## What contract review gives the user
In the UI (`ReviewWizard`): an overall rating derived from the issue counts (critical: "Do not sign yet"; high: "Needs your attention"; medium: "A few things to check"; otherwise "Looks routine"), a plain-English summary with key terms, watch-outs, issues in order of importance with the reason and a verified quote, suggested replacement wording, questions to ask the other side, topics the contract does not mention, and a Word file with tracked changes. It does not decide whether to sign. Obligation and deadline extraction records dates it can parse; **no reminders are created from them**.

Review picks a perspective (neutral, customer, vendor, employer or employee) because the same clause can favour either side. A careful review of a long contract can take minutes on the private GPU (see AI_SYSTEM.md). At most 80 clauses are assessed per review (`MAX_CLAUSES`).

## Library and corpus sources
Admins add sources on the Authorities page; everything is kept with dated versions so a question tied to an earlier date uses the text then in force. The library holds public text only; users' private documents never go into it.

| Source type | Status per `legal-sources.md` |
|---|---|
| Federal regulations (eCFR adapter) | Official eCFR API, no key; verified against the live API. |
| Federal statutes (U.S. Code adapter) | Official GPO link service, no key; verified live. |
| Official https URLs (agency guidance, court rules, state statutes as pages or PDFs) | Public https only, conditional GET, SSRF-safe. |
| Court opinions (CourtListener adapter) | Needs a free token (`COURTLISTENER_TOKEN`); the README says support is mock-tested only, while `legal-sources.md` says it was verified against the live API. Treat it as unproven until you have run it with your token. |
| State company law (50 states and DC) | LLC act and corporation act per state, with an "Add every state" button; built by checking each official source. |
| Landmark cases | 24 Delaware corporate, startup financing, LLC and securities opinions in `corpus/cases.json`, resolved from CourtListener citations. |
| Templates | Common Paper standard agreements (CC BY 4.0), attribution stored and printed under any draft that used one. |

Treatment ("is this still good law") is **never inferred**. It is entered by a person from an authoritative source or imported from a citator export the owner licenses (`/treatment/import`, up to 2000 entries). With none recorded the answer says "No treatment data".

### Honest coverage gaps
From `modules/legal/docs/legal-sources.md` and `README.md`:
* **Some states have no free official source.** The state catalog shows "no free official source" rather than guessing: official sites that are JavaScript-only, block automated fetching, or only offer a paid or one-section-per-page interface. Some entries carry caveats (a session law or compilation instead of current codified text, partial section coverage, an official mirror host). Read the current statute before relying on it. The catalog carries a generated date and `scripts/verify_source.py` re-checks a source.
* **Not in the library:** state securities ("blue sky") rules, tax code beyond the Section 83 regulations, and case law beyond the 24 landmark opinions plus whatever the owner adds. Only some states' entity statutes have one-click presets (Delaware and North Carolina are named there).
* The YC SAFE and NVCA documents are **not** fetched automatically because their terms were not verified; the owner must upload them. Founders agreements, operating agreements, offer letters and similar have no verified open-licensed template, so they use the original outlines in `startup/catalog.py`.
* No citator data ships with the system.
* The retrieval benchmark has 103 questions over 7 contracts; the README says it is small and was tuned on its own questions.
* OCR quality depends on scan quality; ClamAV is not deployed (built-in upload checks are always on); backups on the server share the data volume (an off-site puller exists but runs only when scheduled on the owner's PC).

## Startup workflow
Home shows a first-run company form, three actions (Review a contract, Create a document, Ask a legal question) and the checklist. The catalog (`startup/catalog.py`) has these draftable document types: founders agreement, LLC operating agreement, mutual NDA, independent contractor agreement, employee offer letter, advisor agreement, IP assignment agreement, website/app privacy policy and terms of service. Each has a list of plain questions and a conventional clause outline; anything the user leaves blank becomes a `[●PLACEHOLDER]` rather than an invented value. The checklist has 13 items (formation, founders agreement, operating agreement, bylaws and board consents, founder stock purchase agreements, 83(b) election, IP assignment, contractor agreements, offer letters, NDA, privacy policy, terms of service, optional fundraising documents, with applicability by entity type); items with no draftable type are manual marks.

## What LegalAI will not claim
* That it is a lawyer or law firm, or that output is legal advice.
* That a case is good law, that a source is current beyond the date it was last verified, or that coverage is complete.
* A numeric confidence score.
* That a document is valid, enforceable or complete.
* That an AI answer is right: output is a draft for review.
* That documents are used to train models (they are not; nothing is trained) or leave the private GPU. The exceptions the code allows are explicit and off by default: external embeddings for `standard` matters (or `private` ones that opted in) when a Voyage key is configured, and external LLM fallback (off, needs a configured provider, a non-zero budget and the matter's consent). See AI_SYSTEM.md.

## Operating notes
* Accounts: LegalAI is the interim identity provider. The first account is created once with `POST /api/auth/bootstrap` (refused once any user exists); later users are created by an admin, or by the shell's self-serve signup through the private `POST /api/internal/users` (gated by `INTERNAL_PROVISION_TOKEN`, 404 when the token is unset or under 32 characters; the account is a normal non-admin user and no session is created). See docs/SIGNUP.md. There is no password reset.
* Sign-in security: Argon2 password hashes, optional TOTP two-step sign-in with hashed recovery codes, session cookie `httponly` and `SameSite=lax`, per-session CSRF header, login rate limit (10 per 5 minutes).
* Tests: `cd modules/legal/api && ../../../.venv/Scripts/python -m pytest -q` (needs the compose Postgres on :5442; creates `legalai_test`).
