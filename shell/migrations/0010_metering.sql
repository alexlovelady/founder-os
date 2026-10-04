-- Metering: a dedupe key on usage events so a value reported more than once (for example tokens of one AI job, polled repeatedly) is recorded once.
-- Re-runnable. Existing rows keep external_id NULL and are never constrained.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS usage_events_external_unique ON usage_events (business_id, metric, external_id) WHERE external_id IS NOT NULL;
