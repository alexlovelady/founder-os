-- Platform admin: user suspension. Idempotent (the test harness replays every file).
-- One row per user. lifted_at IS NULL means the suspension is in force. Accounts live in LegalAI, so user_id is its text id (no foreign key).
CREATE TABLE IF NOT EXISTS platform_suspensions (
  user_id      text PRIMARY KEY,
  reason       text NOT NULL,
  suspended_by text NOT NULL,
  suspended_at timestamptz NOT NULL DEFAULT now(),
  lifted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS platform_suspensions_active ON platform_suspensions (suspended_at DESC) WHERE lifted_at IS NULL;
