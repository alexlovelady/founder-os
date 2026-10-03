-- Self-serve signup: invite codes and an attempt log used for rate limiting and auditing.
-- Only a SHA-256 hash of a code is stored (the raw code is shown once to the administrator who creates it).
-- signup_attempts stores keyed hashes only: never a raw email address or IP address.
-- Idempotent: the test setup applies every migration repeatedly.
CREATE TABLE IF NOT EXISTS signup_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash  text NOT NULL UNIQUE,
  label      text NOT NULL DEFAULT '',
  max_uses   integer NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  use_count  integer NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses),
  expires_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS signup_codes_created ON signup_codes (created_at DESC);

CREATE TABLE IF NOT EXISTS signup_attempts (
  id         bigserial PRIMARY KEY,
  ip_hash    text NOT NULL,
  email_hash text NOT NULL,
  outcome    text NOT NULL,   -- started | created | invalid_code | duplicate | unavailable | failed
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signup_attempts_ip ON signup_attempts (ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS signup_attempts_email ON signup_attempts (email_hash, created_at DESC);
