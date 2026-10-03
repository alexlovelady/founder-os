/**
 * Migration 0002_admin_rules. These two tables are the ONE exception to the "every table has business_id" rule: they hold platform-wide
 * compliance content managed by platform admins, never business data. Businesses never read or write them directly; the checklist sync
 * reads published rows, and only the shell's platform-admin-guarded API writes them.
 */
export const ADMIN_RULES_MIGRATION = {
  name: "0002_admin_rules",
  sql: `CREATE TABLE compliance_admin_rules (
    id               text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
    version          int NOT NULL DEFAULT 1,
    title            text NOT NULL,
    description      text NOT NULL DEFAULT '',
    category         text NOT NULL DEFAULT 'other',
    conditions       jsonb NOT NULL DEFAULT '[]'::jsonb,
    always_cautious  boolean NOT NULL DEFAULT false,
    recommendation   text NOT NULL DEFAULT '',
    cautious         text,
    priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('high','normal')),
    source_title     text NOT NULL DEFAULT '',
    source_url       text NOT NULL DEFAULT '',
    jurisdiction     text NOT NULL DEFAULT 'US',
    last_verified    date,
    recurrence       text CHECK (recurrence IS NULL OR recurrence IN ('monthly','quarterly','yearly')),
    deadline         jsonb,
    enabled          boolean NOT NULL DEFAULT false,
    status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','disabled')),
    last_checked_at  timestamptz,
    last_status      int,
    last_checked_url text,
    last_check_note  text,
    created_by       text NOT NULL DEFAULT '',
    updated_by       text NOT NULL DEFAULT '',
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX compliance_admin_rules_published ON compliance_admin_rules (status, enabled);
  CREATE TABLE compliance_admin_rule_versions (
    id          bigserial PRIMARY KEY,
    rule_id     text NOT NULL REFERENCES compliance_admin_rules(id) ON DELETE CASCADE,
    version     int NOT NULL,
    snapshot    jsonb NOT NULL,
    changed_by  text NOT NULL DEFAULT '',
    changed_at  timestamptz NOT NULL DEFAULT now(),
    note        text NOT NULL DEFAULT ''
  );
  CREATE INDEX compliance_admin_rule_versions_rule ON compliance_admin_rule_versions (rule_id, id);`,
};
