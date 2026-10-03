-- Platform services: audit log, privacy settings, feature flags, feedback, product analytics.
-- Idempotent on purpose (the test harness replays every file).

-- Audit log. business_id has NO foreign key: platform events have no business, and the "business deleted" event must outlive the business.
CREATE TABLE IF NOT EXISTS audit_events (
  id            bigserial PRIMARY KEY,
  business_id   uuid,
  user_id       text,
  action        text NOT NULL,
  resource_tool text,
  resource_id   text,
  meta          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_business_created ON audit_events (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_created ON audit_events (created_at DESC);

-- Privacy settings: one row per business (absent row = defaults).
CREATE TABLE IF NOT EXISTS privacy_settings (
  business_id             uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  ai_data_use_notes       text NOT NULL DEFAULT '',
  allow_product_analytics boolean NOT NULL DEFAULT true,
  updated_by              text,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Feature flags.
CREATE TABLE IF NOT EXISTS feature_flags (
  key         text PRIMARY KEY,
  description text NOT NULL DEFAULT '',
  enabled     boolean NOT NULL DEFAULT false,
  rollout_pct integer NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  enabled     boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, key)
);
-- Defaults: on for areas that exist as tools today (crm, marketing); off for the rest until they ship.
INSERT INTO feature_flags (key, description, enabled) VALUES
  ('crm_enabled', 'CRM tool', true),
  ('marketing_enabled', 'Marketing tool', true),
  ('automations_enabled', 'Automations (not built yet)', false),
  ('business_collaboration_enabled', 'Inviting teammates / collaboration', false),
  ('finance_connections_enabled', 'Bank / accounting connections (not built yet)', false)
ON CONFLICT (key) DO NOTHING;

-- Feedback inbox.
CREATE TABLE IF NOT EXISTS feedback (
  id          bigserial PRIMARY KEY,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('bug', 'feature', 'confusing', 'other')),
  message     text NOT NULL,
  page        text NOT NULL DEFAULT '',
  user_agent  text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'handled')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS feedback_user_created ON feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_status_created ON feedback (status, created_at DESC);

-- Product analytics (first-party only).
CREATE TABLE IF NOT EXISTS analytics_events (
  id          bigserial PRIMARY KEY,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     text,
  name        text NOT NULL,
  props       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analytics_events_name_created ON analytics_events (name, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_business ON analytics_events (business_id, created_at DESC);
