# Platform admin portal

Everything under `/admin` and `/api/admin` requires a signed-in LegalAI account with `role === "admin"`, checked on the server on every request (pages via `requireAdminPage`, new APIs via `requireAdmin` in `shell/src/lib/admin/guard.ts`). Anyone else gets a 404. State-changing requests also get the same-origin check. Admins see counts, totals and profile fields only: never document contents or row-level tool data. Admin actions are written to the audit log with `recordAudit`.

## Pages

| Page | Shows | Source |
| --- | --- | --- |
| `/admin` | Users, businesses, audit and event counts, plus headline estimated MRR, paying subscribers, AI requests this month, suspended users, unhandled feedback (each links to its page), and row counts per tool table | `adminOverview`, `loadHeadlines` |
| `/admin/revenue` | Estimated MRR, subscribers per plan, trials, past due, cancellations (30 and 90 days), ARPU, a 6-month new and canceled series, trial-to-paid conversion | `subscriptions`, `plan_overrides`, `analytics_events`, list prices in `shell/src/config/plans.ts` |
| `/admin/usage` | Requests, tokens, estimated cost, by metric, top businesses, by day (default last 30 days), date and metric filters, CSV export per table, cost as % of estimated MRR | `usage_events` |
| `/admin/users` | Users the shell knows, email and name, business count, last seen, suspend and lift with a required reason | `business_members`, `team_member_profiles` (if present), `platform_suspensions` |
| `/admin/ai` | LegalAI reachability, AI requests this month, per-plan AI request limits and `aiTier`, how to change models | `LEGAL_URL` `/healthz`, `plans.ts`, `usage_events` |
| `/admin/businesses/[id]` | (existing content) plus the plan and override section: effective plan and its source, and a form to set or clear an override | `resolvePlan`, `setPlanOverride`, `clearPlanOverride` |
| `/admin/audit`, `/admin/flags`, `/admin/feedback`, `/admin/analytics`, `/admin/signup` | unchanged | platform services |

## What is estimated or missing

- **MRR is an estimate.** It sums list prices from `plans.ts` for subscriptions in status `active`, `trialing` or `past_due` on a paid plan. It excludes the free plan and every business with an admin plan override. It ignores discounts, coupons, tax, proration, annual billing and failed charges. Stripe is the source of truth for what was billed; there is no Stripe call in the portal.
- **ARPU** is estimated MRR divided by the subscribers counted in it (trials included).
- **Cancellations** are subscription rows now in status `canceled`, bucketed by `updated_at`. The table has no `created_at`, so a canceled row that is later updated drops out of its original month.
- **New subscriptions** in the monthly series come from `subscription_started` analytics events. Businesses that opted out of analytics are not counted, and the column is empty until something emits the event.
- **Trial-to-paid** is an approximation: of businesses with a `subscription_started` event, the share now `active` on a paid plan. It cannot separate trial starts from direct purchases. Shows "no data" without events.
- **Billing not enabled** (no `STRIPE_SECRET_KEY`): the revenue page says "Billing is not enabled; every business is on the top plan" and shows whatever subscription rows exist.
- **Tokens**: `usage_events` has no token columns. Tokens appear only when a tool records a metric whose name contains `token`. Nothing does today, so tokens show "not reported".
- **Cost** is the sum of `estimated_cost_usd` where a caller supplied it. The by-metric table shows on how many events cost and model were recorded. There is no tool column, so the page cannot attribute events to a tool or show per-provider/feature/user breakdowns from the spec.
- **Cost as % of revenue** appears only when the last 30 days have reported cost and estimated MRR is above zero. It compares reported cost with estimated MRR, not with invoices.
- **AI page** is read-only. LegalAI `/healthz` returns only `{ok: true}`, so the page can say reachable or not but cannot list the loaded models. Model routing, temperature, prompts and token caps are not configurable from the portal.

## Usage CSV export

`GET /api/admin/usage/export?view=metric|business|day&from=YYYY-MM-DD&to=YYYY-MM-DD&metric=...` (admin only, audited as `admin.usage.export`). Cells starting with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets do not run them as formulas. Costs are blank where nothing reported one.

## Plan overrides

On a business page an admin picks a plan, an optional per-limit override (blank keeps the plan value, `unlimited` removes the limit) and a required reason. `PUT /api/admin/businesses/[id]/plan-override` sets it and `DELETE` clears it; both use `setPlanOverride` and `clearPlanOverride` from `@/lib/billing`, are audited (`admin.plan_override.set` and `.clear`, with the business id) and return the effective plan. An override wins over any Stripe subscription until cleared and is excluded from estimated revenue.

## User suspension

Table `platform_suspensions` (migration `0007_admin.sql`): one row per user, in force while `lifted_at IS NULL`.

Library `shell/src/lib/admin/suspensions.ts`:

- `isSuspended(sql, userId): Promise<boolean>`: the function the session check must call. It returns false if the table does not exist yet.
- `suspendUser`, `liftSuspension`, `listSuspensions`, `listUsers`, `countActiveSuspensions`.

API (admin only): `POST` and `DELETE /api/admin/users/[id]/suspension` with body `{ "reason": "..." }` (required for both suspending and lifting), and `GET /api/admin/suspensions[?active=1]`. There is deliberately no public "is this user suspended" endpoint.

Limits: the shell only knows the caller's own role, so it refuses self-suspension but cannot tell whether another user is an admin. Check before suspending a colleague. Suspension only means something once the session check calls `isSuspended`; until then the table records intent only. Re-suspending a lifted user overwrites the row; the history is in the audit log.

## Testing

`npx vitest run shell/tests/admin` from the repo root. Revenue math is table-driven and pure. Usage, suspension and override tests run against the real `founderos_test` Postgres with every shell migration applied. API handlers live in `shell/src/lib/admin/handlers.ts` and take an injectable `AdminDeps.getSession`, which is how admin-only enforcement is tested for each endpoint without cookies; the route files only pass the real dependencies.
