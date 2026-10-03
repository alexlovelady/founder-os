-- Team collaboration: invites and a small profile cache so owners can recognize members.
-- Interim identity: accounts live in LegalAI and are created by its administrator, so an invite is a link (no email is sent) that a signed-in
-- user opens to join a business. Only a SHA-256 hash of the token is stored; the raw token is shown once to the inviter.
-- Idempotent: the test setup applies every migration repeatedly.
CREATE TABLE IF NOT EXISTS team_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash  text NOT NULL UNIQUE,
  email       text,                                   -- optional restriction (stored lower-case): only a signed-in user with this email may accept
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_by text,                                   -- the most recent user who accepted
  accepted_at timestamptz,
  revoked_at  timestamptz,
  max_uses    integer NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  use_count   integer NOT NULL DEFAULT 0 CHECK (use_count >= 0 AND use_count <= max_uses)
);
CREATE INDEX IF NOT EXISTS team_invites_business ON team_invites (business_id, created_at DESC);

-- What the shell knows about people: refreshed for the current user on every team page / API call.
CREATE TABLE IF NOT EXISTS team_member_profiles (
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  email        text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, user_id)
);
