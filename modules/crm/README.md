# CRM (`modules/crm`)

A lightweight CRM for a small business: contacts, a sales pipeline, notes, and follow-up flags for deals that have gone quiet.

## Pages (`/app/t/crm/...`)
| Path | What |
|---|---|
| `/` | Contact list: search (name, company, email, notes), type filter, add contact (with duplicate warning), CSV import and export |
| `/contacts/<id>` | Contact detail: edit, opportunities, timeline (notes and stage changes), Linked items box, "Create follow-up task" |
| `/pipeline` | Board with one column per stage, column totals, stale and past-close badges, stage select on every card, win rate and average days per stage |
| `/opportunities/<id>` | Opportunity detail: stage buttons, edit, notes, timeline, Linked items |

## Tables (all carry `business_id`, all queries filter by it)
`crm_contacts`, `crm_opportunities`, `crm_notes`, `crm_stage_history` (one row per stage change, including the initial stage).
Deleting a contact deletes its opportunities, notes and history.

## API (`/api/tools/crm/...`)
`GET/POST contacts`, `GET/PATCH/DELETE contacts/:id`, `POST contacts/:id/notes`, `GET contacts/export` (CSV), `POST contacts/import` (`{csv, allowDuplicates?}`),
`GET duplicates?email=`, `GET/POST opportunities`, `GET/PATCH/DELETE opportunities/:id`, `POST opportunities/:id/stage` (`{stage, lostReason?}`),
`POST opportunities/:id/notes`, `GET pipeline`, `GET stale?staleDays=`. All writes require a non-viewer role. Ids and roles always come from the session, never the request.

## Behaviour
- **Duplicates:** a second contact with the same email (case-insensitive) in the same business returns 409 with the matching contacts; send `allowDuplicate: true` to override. CSV import skips such rows unless `allowDuplicates` is set. Blank emails never count as duplicates.
- **CSV import:** columns `name` (required), `company`, `email`, `phone`, `type`, `tags` (separated by `;`). Valid rows are imported; each bad row is reported with its line number and reason (missing name, bad email, unknown type, duplicate in the file, email already in the CRM). Max 2000 rows. CSV export neutralises spreadsheet formulas (a leading `=`, `@`, or non-phone `+`/`-` gets a `'` prefix).
- **Stages:** lead, contacted, qualified, proposal_sent, negotiation (open) and won, lost (closed). Moving to `lost` requires a reason. Reopening clears the close date and reason. Every change writes `crm_stage_history`.
- **Stale:** an open opportunity with no activity for 14 days (default; `?staleDays=` on the API). Activity is a note, a stage change, an edit, or creating the opportunity. For contacts, an active `lead` with no open opportunity and no activity for 14 days counts as stale. Closed deals are never stale.
- **Follow-up task button:** the browser POSTs `{ title, sourceRef: { tool: "crm", id: <contactId> } }` to `/api/tools/tasks/from-source`. A 404 shows "Tasks tool not available yet". This tool never imports the tasks package.

## Publishes
- `facts()`: `contactCount`, `customerCount`, `openOpportunities`, `pipelineValueCents`, `wonLast90DaysCents`, `staleCount` (stale open deals plus stale leads), `hasFollowUpProcess: false`.
- `describe()`: one short paragraph (contacts, open pipeline value, won in 90 days, stale count). No names, emails or phones. Empty when there are no contacts.
- `attention()`: one item per open deal whose expected close date has passed (`crm-pastclose-<id>`, with `dueDate`) and per stale open deal (`crm-stale-<id>`); at most 10, extra ones roll up into `crm-more`.
- `resolve()` for contacts (`/app/t/crm/contacts/<id>`) and opportunities (`/app/t/crm/opportunities/<id>`); `search()` over contact name, company, email, notes and opportunity titles.

## Privacy
Emails and phones are personal data: they are never logged and never put in `describe`, `attention` or search snippets. The CSV export is the only bulk read.

## Not built (deliberately)
Drag-and-drop on the board (stage selects instead), email sync or sending, custom fields and custom stages, multiple owners and per-user assignment (owner is free text), a configurable stale threshold in the UI (API only), merging duplicates, pagination beyond 500 contacts in the list view (export has a 2000 cap), AI features.

## Tests
`npx vitest run modules/crm` (needs the local `founderos_test` Postgres).
