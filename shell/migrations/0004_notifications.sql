-- Notifications, email outbox, scheduler bookkeeping, weekly briefs and system automations (spec 28, 29, 32, 71, 72).
-- Every statement is idempotent; every row carries business_id.

CREATE TABLE IF NOT EXISTS notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     text,                       -- null = the whole business
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  href        text,
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'review', 'high')),
  dedupe_key  text,
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications (business_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_recent ON notifications (business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_preferences (
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  in_app        boolean NOT NULL DEFAULT true,
  email         boolean NOT NULL DEFAULT false,
  weekly_brief  boolean NOT NULL DEFAULT true,
  quiet_types   jsonb NOT NULL DEFAULT '[]'::jsonb,
  email_address text,                     -- copied from the signed-in session when the user saves preferences; never from the client
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);

CREATE TABLE IF NOT EXISTS email_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid REFERENCES businesses(id) ON DELETE CASCADE,
  to_email        text NOT NULL,
  subject         text NOT NULL,
  body_text       text NOT NULL,
  body_html       text NOT NULL,
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'disabled')),
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS email_outbox_due ON email_outbox (next_attempt_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS scheduled_runs (
  id     bigserial PRIMARY KEY,
  job    text NOT NULL,
  ran_at timestamptz NOT NULL DEFAULT now(),
  ok     boolean NOT NULL,
  detail text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS scheduled_runs_job ON scheduled_runs (job, ran_at DESC);

CREATE TABLE IF NOT EXISTS weekly_briefs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  week_start  date NOT NULL,
  content_md  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, week_start)
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id          bigserial PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  rule        text NOT NULL,
  key         text NOT NULL,
  fired_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, rule, key)
);
