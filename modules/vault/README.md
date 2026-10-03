# Document vault (`vault`)

The central, organized file store for the business: formation records, contracts, policies, insurance, tax papers and so on, with metadata,
expiry dates and version history. **Legal review of a document happens in LegalAI** (a separate service); the vault only stores and organizes
files and tells other tools what exists. It does not read or assess file contents.

## Tables
* `vault_documents`: name, original_filename, category, doc_type (free text), tags text[], status (`active|draft|review|archived`), expiration_date,
  version, sha256, size, content_type, uploaded_by.
* `vault_blobs`: file bytes (`bytea`) under a random UUID; separate from the metadata so lists never load file contents.
* `vault_versions`: one row per uploaded version (history is kept; any version can be downloaded).
* Categories: Formation, Legal, Contracts, Taxes, Finance, Insurance, Employees, Contractors, Customers, Vendors, Policies, SOPs, Marketing, Other.

## Files
* Allowed: pdf, docx, doc, xlsx, csv, txt, md, png, jpg, jpeg, webp. Everything else is refused (415) with a message.
* 15 MB per file (413 above that). Filenames are sanitized (path, control and odd characters removed); the user's name is never used for storage.
* Magic bytes must match the extension for pdf, docx/xlsx (zip with the expected office parts), png, jpg/jpeg, webp, and doc (OLE or RTF).
  Text types must not contain NUL bytes. Anything starting like an executable or script (`MZ`, ELF, `#!`, Java/Mach-O) is refused whatever its extension.
* Downloads: `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, a content type chosen from our own allow-list (never the
  browser-supplied one), `Content-Security-Policy: sandbox`, `Cache-Control: no-store`. Every query is scoped by `ctx.businessId`.

## API (`/api/tools/vault/...`)
| Call | What |
|---|---|
| `GET documents` | filters `category`, `status` (default hides archived; `all` shows everything), `expiring=1` (within 60 days or expired), `tag`, `q` (name, filename, doc type, category, tags; ILIKE plus a simple tsvector) |
| `POST documents` | multipart: `file` plus optional `name`, `category`, `docType`, `tags` (comma list or JSON), `status`, `expirationDate` |
| `GET/PATCH/DELETE documents/:id` | detail with versions; rename, move category, tag, change status/expiry; delete (removes all versions and bytes) |
| `POST documents/:id/versions` | multipart `file`: new version, history kept |
| `GET documents/:id/download?version=n` | the file (current version by default) |

## Publishes
* `facts()`: `{ documentCount, categories[] (lowercase), docTypes[] (normalized lowercase), expiringSoon, expired, hasOperatingAgreement, hasPrivacyPolicy,
  hasContractorAgreement, hasInsurance, hasFormationDocs, hasEin }`. Flags come from keywords in category, doc type and name; archived and draft
  documents do not count. They say a document with that label exists, not that it is valid or complete.
* `describe()`: counts per category, which key documents were found or not found, and what is expiring.
* `attention()`: documents expired (high), expiring within 30 days (review) or within 60 days (info); max 10.
* `resolve()` / `search()`: documents by name, filename, type, category or tag; links go to `/app/t/vault/d/<id>`.
* The detail page can create a renewal reminder through the Tasks tool's `POST from-source` (from the browser; shows a message if Tasks is unavailable).

## Known limits
* Plain-text extraction from documents is out of scope for now: search covers metadata only, not file contents.
* No virus scanning (types are restricted and content is checked, but files are not scanned), no per-business storage quota yet.
* Files live in Postgres; very large vaults will eventually want object storage.
* Multipart uploads are buffered in memory (up to the 15 MB cap).
