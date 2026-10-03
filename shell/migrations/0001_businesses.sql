-- FounderOS shell data. Interim identity: user ids come from LegalAI's accounts (text), so a later switch of identity provider
-- only needs a mapping of user ids, not a schema change.
CREATE TABLE IF NOT EXISTS businesses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_version  integer NOT NULL DEFAULT 1,
  name            text NOT NULL,
  legal_name      text NOT NULL DEFAULT '',
  description     text NOT NULL DEFAULT '',
  entity_type     text NOT NULL DEFAULT 'not_sure',
  industry        text NOT NULL DEFAULT '',
  country         text NOT NULL DEFAULT 'United States',
  state           text NOT NULL DEFAULT '',
  city            text NOT NULL DEFAULT '',
  website         text NOT NULL DEFAULT '',
  lifecycle_stage text NOT NULL DEFAULT 'idea',
  employee_count  integer,
  operations      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- yes/no answers: contractors, online payments, personal data, ...
  goals           jsonb NOT NULL DEFAULT '[]'::jsonb,
  modules         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- per-module linkage, e.g. {"legal": {"workspace_id": "..."}}
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS business_members (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  role        text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
CREATE INDEX IF NOT EXISTS business_members_user ON business_members (user_id);
