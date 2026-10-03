# sops: SOPs and business documents

Keeps the business's processes and everyday documents. Works fully without AI; AI drafting is optional and always shown as a draft.

## What it does
- **SOP builder**: guided form producing the standard structure (Title, Purpose, Owner, Frequency, Required Tools, Prerequisites, Procedure, Quality Checks, Exceptions, Escalation, Revision History). The deterministic formatter (`src/sop.ts`) needs no AI; AI can "draft an SOP for X", "improve" or "expand" it.
- **Business documents**: proposal, quote (totals computed on the server), policy, checklist, job description, onboarding checklist, meeting agenda. Templates fill from the business profile; blanks become `[●TO FILL IN]`. Optional AI polish.
- **Editor**: markdown textarea + live preview (own tiny parser in `src/markdown.ts`; renders React elements, never raw HTML, all exports escaped), version history with restore, review cycle (none/quarterly/yearly) and "mark reviewed", download `.md`, Word (`.doc`, HTML that Word opens; no DOCX library), print/save as PDF, LinkedItems.
- **Checklist and tasks**: "Turn into a checklist" rewrites the steps as `- [ ]` items. "Create tasks from these steps" POSTs from the browser to `/api/tools/tasks/from-source` with `{ source: { tool: "sops", id }, title, items: [{ title }] }`; a 404 shows "Tasks tool not available yet". The tasks package is not imported.

## Tables
`sops_documents` (title, kind, body, status, owner, review_frequency, last_reviewed, version) and `sops_versions` (one row per saved revision). Both carry `business_id` and cascade on business delete.

## API (`/api/tools/sops/...`)
`GET/POST documents`, `GET/PUT/DELETE documents/:id`, `POST documents/:id/reviewed`, `GET documents/:id/versions/:n`, `POST documents/:id/restore`, `POST sop/format`, `POST generate`, `POST ai` (returns `{ jobId }`, 202), `GET ai/:jobId` (poll: waiting/running/done/failed).

## Publishes
- `facts`: `{ sopCount, byKind, hasCustomerOnboarding, hasIncidentPlan, hasBackupPlan, lastUpdated }` (keyword detection on titles of non-archived documents).
- `describe`: counts by kind and the latest active SOP titles (<= 600 chars).
- `attention`: active documents past their review date (severity `review`).
- `resolve` / `search`: title and body, href `/app/t/sops/<id>`.

## Known limits
- No real DOCX or PDF generation (Word-compatible HTML and the browser print dialog instead).
- Markdown subset only: no tables or images.
- Version history stores full copies; owner can only be set to a member of the business.
- Task creation depends on the tasks tool's endpoint shape (see above).
