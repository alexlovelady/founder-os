# Document vault (`vault`)

The central, organized file store for the business: formation records, contracts, policies, insurance, tax papers and so on, with metadata,
expiry dates and version history. **Legal review of a document happens in LegalAI** (a separate service); the vault only stores and organizes
files and tells other tools what exists. It reads the plain text of files so they can be searched, but it does not assess what they say.

## Tables
* `vault_documents`: name, original_filename, category, doc_type (free text), tags text[], status (`active|draft|review|archived`), expiration_date,
  version, sha256, size, content_type, uploaded_by.
* `vault_blobs`: file bytes (`bytea`) under a random UUID; separate from the metadata so lists never load file contents.
* `vault_versions`: one row per uploaded version (history is kept; any version can be downloaded).
* `vault_text`: extracted plain text of the current version (`document_id, version, business_id, text` capped at 2 MB, `page_count`, `status`
  `pending|ready|failed|unsupported`, `error`, `extracted_at`, generated `tsv` tsvector, english config, GIN indexed). Older versions' text is removed.
* `vault_documents.ai_summary*`: the latest AI summary (text, time, whether input was truncated, version, and the pending job id).
* `vault_legal_links`: `document_id, version, legal_document_id, legal_review_id, perspective, created_at`: each hand-off to LegalAI.
* Categories: Formation, Legal, Contracts, Taxes, Finance, Insurance, Employees, Contractors, Customers, Vendors, Policies, SOPs, Marketing, Other.

## Files
* Allowed: pdf, docx, doc, xlsx, csv, txt, md, png, jpg, jpeg, webp. Everything else is refused (415) with a message.
* 15 MB per file (413 above that). Filenames are sanitized (path, control and odd characters removed); the user's name is never used for storage.
* Magic bytes must match the extension for pdf, docx/xlsx (zip with the expected office parts), png, jpg/jpeg, webp, and doc (OLE or RTF).
  Text types must not contain NUL bytes. Anything starting like an executable or script (`MZ`, ELF, `#!`, Java/Mach-O) is refused whatever its extension.
* Downloads: `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, a content type chosen from our own allow-list (never the
  browser-supplied one), `Content-Security-Policy: sandbox`, `Cache-Control: no-store`. Every query is scoped by `ctx.businessId`.

## Text extraction, search, classification, summary
* **Extraction** runs after the upload is stored (and on every new version), in the request, best effort: a failure only sets the status, the upload
  still succeeds. Supported: pdf (text layer, via `unpdf`, max 300 pages, 20 s limit), docx and xlsx (own parser over `fflate`; no other dependency),
  txt, md, csv. Text is control-character stripped and capped at 2 MB. Zip-bomb guards for docx/xlsx: at most 2,000 entries, 100 MB declared
  total, 25 MB per unpacked part, 40 MB unpacked in all; only the parts we read are ever inflated.
  A PDF with no text layer is `unsupported` with the reason `scanned image (send it to LegalAI, which runs OCR)`; images the same; old `.doc` is `unsupported`.
* **Re-extract**: `POST documents/:id/extract` (write roles).
* **Search**: `GET documents?q=` still matches metadata (ILIKE and simple tsvector) and now also the extracted text (english full text search, stemmed).
  Results are ranked (a metadata match first, then `ts_rank`) and each text hit carries `snippet`: HTML-escaped text with matches in `<mark>`; the UI
  renders it without innerHTML. Global `search()` also covers file text (plain-text snippet).
* **Classification** (`classify.ts`): deterministic keyword rules over text plus filename suggest a category and doc type (operating agreement, articles,
  bylaws, EIN letter, W-9, tax return, NDA, contractor/employment agreement, privacy policy, terms, insurance, lease, MSA, invoice, SOP) with the matched
  phrases as evidence. It appears in `GET documents/:id` as `suggestion` and in the UI as a chip; it is applied only by the user's click (a normal PATCH).
* **AI summary**: `POST documents/:id/summary` (write roles; 503 when `ctx.ai.available` is false, 409 with no text) starts `ctx.ai` with the business
  context (`ctx.context().asText()`) and the first 6,000 characters of text (the prompt states truncation; the document text is marked as untrusted data),
  after `ctx.useQuota("aiRequestsPerMonth")`. `GET documents/:id/summary` polls `ctx.ai.poll` and stores the result as `ai_summary`, shown with the
  label "AI summary, check against the document".
* `GET documents/:id/text`: first 5,000 characters for the preview panel.

## Review in LegalAI (the hand-off)
The detail page has a "Review in LegalAI" dialog (pick a perspective) that POSTs `{ documentId, perspective }` to the **shell** route
`/api/legalbridge/review` (`shell/src/app/api/legalbridge/review/route.ts`, logic in `shell/src/lib/legalbridge/bridge.ts`). Design choice: the shell does
not import vault internals; the bridge calls this tool's own `api` handler (`GET documents/:id`, `GET documents/:id/download`, `POST documents/:id/legal-link`)
with the signed-in user's tenant-scoped context, so scoping and role checks stay in the vault. It then calls LegalAI server-to-server with the user's cookie
and CSRF token: `POST /api/documents` (multipart `matter_id` from `business.modules.legal.workspaceId`, `file`), waits (bounded) until LegalAI has parsed it,
counts `ctx.useQuota("aiRequestsPerMonth")`, and `POST /api/contracts/review`. Viewers are refused (403). If LegalAI is still reading the file the route answers
202 "processing" and the retry reuses the uploaded copy instead of uploading again. LegalAI unreachable (502), 401, 403, 413, 422, 429 and 5xx map to
plain messages; document contents are never logged. The page then shows "Reviewed in LegalAI, open" linking to `/legal-ui/` (the review itself is read inside LegalAI).

## API (`/api/tools/vault/...`)
| Call | What |
|---|---|
| `GET documents` | filters `category`, `status` (default hides archived; `all` shows everything), `expiring=1` (within 60 days or expired), `tag`, `q` (name, filename, doc type, category, tags; ILIKE plus a simple tsvector) |
| `POST documents` | multipart: `file` plus optional `name`, `category`, `docType`, `tags` (comma list or JSON), `status`, `expirationDate` |
| `GET/PATCH/DELETE documents/:id` | detail with versions; rename, move category, tag, change status/expiry; delete (removes all versions and bytes) |
| `POST documents/:id/versions` | multipart `file`: new version, history kept |
| `GET documents/:id/download?version=n` | the file (current version by default) |
| `POST documents/:id/extract` | re-run text extraction on the current version |
| `GET documents/:id/text` | first 5,000 characters of extracted text and its status |
| `POST` / `GET documents/:id/summary` | start / poll the AI summary |
| `POST documents/:id/legal-link` | record a LegalAI hand-off (used by the shell bridge) |

## Publishes
* `facts()`: `{ documentCount, documentsWithText, categories[] (lowercase), docTypes[] (normalized lowercase), expiringSoon, expired, hasOperatingAgreement, hasPrivacyPolicy,
  hasContractorAgreement, hasInsurance, hasFormationDocs, hasEin }`. Flags come from keywords in category, doc type and name; archived and draft
  documents do not count. They say a document with that label exists, not that it is valid or complete.
* `describe()`: counts per category, which key documents were found or not found, and what is expiring.
* `attention()`: documents expired (high), expiring within 30 days (review) or within 60 days (info); max 10.
* `resolve()` / `search()`: documents by name, filename, type, category or tag; links go to `/app/t/vault/d/<id>`.
* The detail page can create a renewal reminder through the Tasks tool's `POST from-source` (from the browser; shows a message if Tasks is unavailable).

## Known limits
* OCR for scans and images is LegalAI's job (send the file through "Review in LegalAI"); the vault only reports that a file has no text layer.
  Old `.doc` files and encrypted PDFs are not read. Extraction is in-request, so a very large PDF adds up to 20 s to its upload response.
* No virus scanning (types are restricted and content is checked, but files are not scanned), no per-business storage quota yet.
* The classifier is a keyword heuristic; it can be wrong and never changes a document by itself. The AI summary can be wrong too.
* Files live in Postgres; very large vaults will eventually want object storage.
* Multipart uploads are buffered in memory (up to the 15 MB cap).
