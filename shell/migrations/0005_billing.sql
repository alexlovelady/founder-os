-- Billing: subscriptions (mirror of Stripe, which stays the source of truth), usage metering, webhook idempotency, admin plan overrides.
-- Written to be re-runnable (IF NOT EXISTS everywhere).
CREATE TABLE IF NOT EXISTS subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  plan                   text NOT NULL DEFAULT 'free',
  status                 text NOT NULL DEFAULT 'none' CHECK (status IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'none')),
  stripe_customer_id     text,
  stripe_subscription_id text,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  -- When payment first failed; the paid plan is kept for a 7-day grace period from this moment.
  past_due_since         timestamptz,
  -- Time of the newest Stripe event applied, so an old event arriving late cannot undo a newer one.
  last_event_at          timestamptz,
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscriptions_customer ON subscriptions (stripe_customer_id);
CREATE INDEX IF NOT EXISTS subscriptions_stripe_sub ON subscriptions (stripe_subscription_id);

CREATE TABLE IF NOT EXISTS usage_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id            text,
  metric             text NOT NULL,
  quantity           bigint NOT NULL DEFAULT 1,
  model              text,
  estimated_cost_usd numeric,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_events_business_metric ON usage_events (business_id, metric, created_at);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error        text
);

-- Lets the platform admin grant a plan (and optionally custom limits) without Stripe. Wins over any subscription.
CREATE TABLE IF NOT EXISTS plan_overrides (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  plan        text NOT NULL,
  limits      jsonb,
  reason      text NOT NULL DEFAULT '',
  set_by      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
