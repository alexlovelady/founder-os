# Database

The shell has one Postgres database (Railway service `Postgres`, locally `founderos` on port 5442; tests use `founderos_test`). LegalAI has its own separate database and is not described here.
Two migration mechanisms exist, both applied automatically:

| Kind | Where | Applied by | Tracked in |
|---|---|---|---|
| Shell (platform) migrations | `shell/migrations/NNNN_name.sql` | `shell/scripts/migrate.mjs` at container start (`node scripts/migrate.mjs` locally); each file runs once in a transaction, in name order | `schema_migrations` |
| Tool migrations | `tool.migrations` (`{ name, sql }`) in each `modules/<id>/src/index.tsx` | `runToolMigrations` (`modules/sdk/src/migrate.ts`) from `shell/src/instrumentation.ts` at server start; one at a time under an advisory lock | `tool_migrations (tool, name)` |

The test harness (`makeTestEnv` in `@founderos/sdk/testing`) re-executes every `shell/migrations/*.sql` file on each run, so shell migrations **must be idempotent**
(`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `INSERT ... ON CONFLICT DO NOTHING`), then runs the tool migrations it is given.

## Shell schema (current files)
* `0001_businesses.sql`: `businesses` (profile, `operations` and `goals` as jsonb, `modules` jsonb for per-module links such as the LegalAI workspace id), `business_members (business_id, user_id text, role owner|admin|member|viewer)`.
  User ids are LegalAI account ids stored as text so a later identity provider only needs an id mapping.
* `0002_entity_links.sql`: `entity_links` cross-tool links `(business_id, from_tool, from_id, to_tool, to_id, kind)`, unique per combination.
* `0003_platform.sql`:
  * `audit_events (id bigserial, business_id uuid NULL, user_id, action, resource_tool, resource_id, meta jsonb, created_at)`, index `(business_id, created_at DESC)`.
    `business_id` deliberately has no foreign key so platform events are possible and the "business deleted" event survives the deletion.
  * `privacy_settings (business_id PK, ai_data_use_notes, allow_product_analytics default true)`.
  * `feature_flags (key PK, description, enabled default false, rollout_pct 0-100 default 100, updated_by, updated_at)` seeded with `crm_enabled` and `marketing_enabled` on, and
    `automations_enabled`, `business_collaboration_enabled`, `finance_connections_enabled` off; `feature_flag_overrides (business_id, key, enabled)`.
  * `feedback (id, business_id, user_id, kind bug|feature|confusing|other, message, page, user_agent, status new|handled, created_at)`.
  * `analytics_events (id, business_id, user_id, name, props jsonb, created_at)`.
* Other platform services (notifications, billing, team) add their own later numbered files; see the folder for the full list.

## Tool tables
One prefix per tool: tool `crm` owns `crm_*`, `vault` owns `vault_*`, and so on (competitors, compliance, finance, founderai, health, marketing, product, sops, tasks). Current tables:
competitors_items/pages/analyses/reports/discoveries/fetch_log, compliance_items, crm_contacts/opportunities/notes/stage_history, finance_calculations, founderai_conversations/messages,
health_confirmations, marketing_brand/items/jobs, product_repos/scans, sops_documents/versions, tasks_items, vault_documents/blobs/versions (and later vault tables). The authoritative list is each tool's migrations.

## Conventions
1. Every tenant table has `business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE`, and every query filters by it. Deleting a business therefore removes all its tool data.
2. Ids are `uuid DEFAULT gen_random_uuid()` for tool records; platform log-style tables use `bigserial`.
3. Timestamps are `timestamptz DEFAULT now()`. Flexible structured fields are `jsonb`. Binary file contents are `bytea` (vault blobs) and are excluded from exports.
4. Do not store secrets in plain columns; if one is unavoidable name it with `token`, `secret`, `password` or `encrypted` so exports and admin views skip it automatically.
5. Index what you filter by (`business_id` first). Add `CHECK` constraints for enums.
6. Never edit an applied migration; add a new file or a new tool migration entry.

## Adding a migration
* Platform table: add `shell/migrations/NNNN_name.sql` with the next number, written to be re-runnable. Run `node scripts/migrate.mjs` locally (or just run the tests).
* Tool table: append `{ name: "000N_x", sql }` to the tool's `migrations`; it runs at the next server start. Test it with `makeTestEnv([tool])`.
* Parallel work: two agents must not use the same number; the lead assigns numbers.

## Privacy and data lifecycle
* Export: `exportBusinessData` (`shell/src/lib/platform/privacy.ts`) discovers `<toolid>_*` tables via `information_schema` and exports rows filtered by `business_id`; tables without `business_id` are listed as skipped.
* Delete: deleting the `businesses` row cascades to all tenant tables (`ON DELETE CASCADE`). That is why rule 1 matters: a tool table without the cascading `business_id` would leave data behind.
* Audit rows of a deleted business are removed explicitly because they have no foreign key.

## Backups
Not automated for this database in the repository; see docs/SECURITY.md for the honest status and docs/railway.md for what to enable.
