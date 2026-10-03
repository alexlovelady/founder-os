# Billing (Stripe) and usage limits

Status: code complete, **inactive until Stripe keys exist**. Without `STRIPE_SECRET_KEY` the billing page says "Billing is not enabled yet", every business is on the Free plan, upgrade buttons are disabled with that explanation, and the checkout/portal APIs answer 503. Nothing ever fakes a checkout.

## Where things live
| What | Where |
|---|---|
| Plans, prices, limits, features (the only place) | `shell/src/config/plans.ts` |
| Plan resolution, usage, quotas, admin hooks | `shell/src/lib/billing/core.ts` |
| Which metrics are monthly vs stock | `shell/src/lib/billing/metrics.ts` |
| Stripe checkout, portal, webhook, signature check | `shell/src/lib/billing/stripe.ts` |
| Env parsing and price-id to plan map | `shell/src/lib/billing/config.ts` |
| API | `POST /api/billing/checkout`, `POST /api/billing/portal`, `POST /api/billing/webhook`, `GET /api/billing/summary` |
| Page | `/app/billing` |
| Tables | `shell/migrations/0005_billing.sql`: `subscriptions`, `usage_events`, `stripe_events`, `plan_overrides` |
| Upgrade prompt for tools | `UpgradePrompt` in `shell/src/components/billing/UpgradePrompt.tsx` |

## Rules implemented
* Plan in force: admin override, else `active`/`trialing` subscription, else Free. `past_due` keeps the paid plan for 7 days from the first failed payment, then Free. `canceled` and `unpaid` are Free.
* Monthly metrics (`aiRequestsPerMonth`) count usage events in the current UTC calendar month. Stock metrics (`storageMb`, `teamMembers`, `competitors`, `productRepos`) are the current totals counted from the tables (`vault_blobs`, `business_members`, `competitors_items`, `product_repos`); a missing table counts as 0. Stock metrics are checked, not recorded.
* `useQuota` throws `HttpError(402)` with a plain message naming the limit and the cheapest plan that raises it. The check and the insert run under a Postgres advisory lock per business and metric, so parallel requests cannot both take the last unit.
* Tool metric names are mapped: `ai_request(s)` to `aiRequestsPerMonth`, `storage_bytes` to `storageMb` (bytes converted), `team_members`, `product_repos`. Any other name (for example token counts) is recorded without a limit.
* Stripe is the source of truth. Plan ids come only from the price-id env map; the browser sends just a plan name that must be one of ours. Checkout and portal need the owner or admin role.
* Webhook: raw body, `Stripe-Signature` (`t=`, `v1=`, 5-minute tolerance, constant-time compare), idempotent by event id in `stripe_events`. A failed event returns 500 so Stripe retries; a repeated successful event is acknowledged without being applied again. Events older than the last applied one for a business are ignored, and a late event about an old subscription cannot cancel the current one. Events with an unmapped price id, or for unknown businesses, are acknowledged and ignored (the reason is stored in `stripe_events.error`).
* Handled events: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`.

## How the owner switches billing on
1. In Stripe (start in **test mode**), create three Products, each with one recurring **monthly** Price in USD matching `shell/src/config/plans.ts`: Founder ($24), Pro ($59), Business ($149). If you change a price, change it in `plans.ts` and create a new Stripe price; plans.ts is display only, Stripe decides what is charged.
2. Copy each price id (`price_...`).
3. In Stripe, enable the **Customer portal** (Settings, Billing, Customer portal): allow cancel, payment method update, and plan switching between the three prices.
4. Set these variables on the Railway `shell` service:
   * `STRIPE_SECRET_KEY` (`sk_test_...` first, `sk_live_...` later)
   * `STRIPE_WEBHOOK_SECRET` (step 5)
   * `STRIPE_PRICE_FOUNDER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`
   * `STRIPE_TRIAL_DAYS` (optional, default 0)
   * `APP_URL` (optional but recommended, e.g. `https://shell-production-86b1.up.railway.app`, used for Stripe return links)
5. In Stripe, Developers, Webhooks, add endpoint `https://<your shell address>/api/billing/webhook` and select exactly these events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`.
6. Redeploy the shell (migration `0005_billing.sql` must have been applied).
7. Test in test mode: open `/app/billing`, press Upgrade, pay with card `4242 4242 4242 4242` (any future date and CVC). Within a minute the page should show the new plan. Try `Manage subscription`, then cancel. For a failed payment use card `4000 0000 0000 0341` or the portal.
8. Local testing with the Stripe CLI: `stripe listen --forward-to localhost:3000/api/billing/webhook` prints a `whsec_` secret for local use; `stripe trigger invoice.payment_failed` sends sample events (they will be ignored because they carry no known business or price; use a real test checkout for end-to-end).
9. Going live: repeat with live-mode products, keys and a live webhook endpoint.

## Platform admin and tools (for the lead)
* Admin: `setPlanOverride(sql, businessId, plan, limits, reason, adminId)`, `clearPlanOverride(sql, businessId)`, `listSubscriptions(sql)` from `@/lib/billing`.
* `ToolContext.plan` = `await getBusinessPlan(sql, businessId)`; `ToolContext.useQuota(metric, amount)` = `useQuota(sql, businessId, userId, metric, amount)`.
* When an API returns 402, show `<UpgradePrompt message={error} />`.

## Not tested against live Stripe
All tests use a locally computed signature (`signStripePayload`) and an injected fake Stripe HTTP layer; nothing touches the network. Not verified against the real service: the exact response shapes of Checkout/Portal sessions on your account's API version (the code reads `url` and, for subscriptions, both `current_period_end` locations), portal configuration, tax, proration, coupons, refunds and disputes (no handling), multiple currencies, annual prices (only monthly price ids are mapped), and live-mode behaviour. Do a full test-mode run (step 7) before going live.

## Not built
* Annual billing, tax (Stripe Tax), invoices list in-app (use the portal), seat-based pricing.
* Metering of tokens and cost per model: `recordUsage` accepts `model` and `estimatedCostUsd`, but no tool reports them yet.
* A per-plan admin editor for limits (limits live in `plans.ts`; per-business exceptions use `plan_overrides`).
* Emails for payment failures (the page shows a banner; notifications can be added when the email provider exists).
