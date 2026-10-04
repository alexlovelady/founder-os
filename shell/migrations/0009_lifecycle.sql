-- Account lifecycle: password reset links, email verification for open signup, and an attempt log for rate limits.
-- Only SHA-256 hashes of tokens are stored (the raw token exists only in the emailed or admin-shown link).
-- lifecycle_attempts stores keyed hashes only: never a raw email address, IP address or user id.
-- Idempotent: the test setup applies every migration repeatedly.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL,                 -- LegalAI user id (no foreign key: accounts live in LegalAI)
  token_hash text NOT NULL UNIQUE,          -- SHA-256 hex of the raw token
  created_by text NOT NULL CHECK (created_by = 'self' OR created_by LIKE 'admin:%'),
  expires_at timestamptz NOT NULL,          -- 30 minutes for self-serve, 24 hours for admin-created
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS email_verifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    text NOT NULL,                 -- the inactive LegalAI account this verifies (the address itself is NOT stored here)
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,          -- 24 hours
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_verifications_user ON email_verifications (user_id);

CREATE TABLE IF NOT EXISTS lifecycle_attempts (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,               -- forgot | resend | reset | verify | delete
  ip_hash      text NOT NULL,
  subject_hash text,                        -- keyed hash of the email (or user id for delete); null when there is none
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lifecycle_attempts_ip ON lifecycle_attempts (kind, ip_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS lifecycle_attempts_subject ON lifecycle_attempts (kind, subject_hash, created_at DESC);
