-- Operations: first-party error capture (error_events) and the record of scheduled database backups (shell_backups).
-- error_events holds NO personal data: no user ids, business ids, query strings, headers, cookies or bodies; message and stack are sanitized before they get here.
-- Idempotent: the test setup applies every migration repeatedly.
CREATE TABLE IF NOT EXISTS error_events (
  id          bigserial PRIMARY KEY,
  fingerprint text NOT NULL UNIQUE,
  route       text NOT NULL DEFAULT '',
  method      text NOT NULL DEFAULT '',
  message     text NOT NULL DEFAULT '',
  stack       text NOT NULL DEFAULT '',
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  count       integer NOT NULL DEFAULT 1,
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS error_events_last_seen ON error_events (last_seen DESC);

CREATE TABLE IF NOT EXISTS shell_backups (
  id               bigserial PRIMARY KEY,
  file_name        text,
  size_bytes       bigint,
  sha256           text,
  tables           jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified         boolean NOT NULL DEFAULT false,
  restore_verified boolean,
  created_at       timestamptz NOT NULL DEFAULT now(),
  error            text
);
CREATE INDEX IF NOT EXISTS shell_backups_created ON shell_backups (created_at DESC);
