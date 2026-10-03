# Notifications, scheduler, weekly brief and system automations

Code: `shell/src/lib/notify/`, UI: `shell/src/components/notify/` and `/app/notifications`, API: `/api/notifications/*`, tables: `shell/migrations/0004_notifications.sql`. Spec sections 28, 29, 32, 71, 72.

## In-app notifications

- `createNotification(sql, businessId, input: NotifyInput, { userId?, emailEnabled? })`. Idempotent on `(business_id, dedupeKey)`; the first call wins and only it can queue email. `userId` omitted = the whole business. Wire it as `ctx.notify` with `{ notify: (n) => createNotification(sql, businessId, n).then(() => {}) }` in `withPlatform` services.
- `listNotifications`, `unreadCount`, `markRead`, `markAllRead` take `(sql, businessId, userId, ...)`. A user sees notifications addressed to them plus business-wide ones. Business-wide notifications share one read state.
- Notification "type" = the part of the dedupe key before the first `:` (`reminder:...`, `compliance-due-30:...`). Users can mute a type or a severity for email in their preferences (`quietTypes`); in-app is not affected by quiet types.
- Links are only stored if they are a site path (`/...`) or http(s); long titles and bodies are shortened rather than rejected.
- API (all scoped by the signed-in session, never by the request): `GET /api/notifications?limit&unread`, `GET /api/notifications/unread-count`, `POST /api/notifications/read` (`{id}` or `{all:true}`), `GET|PUT /api/notifications/preferences`.
- UI: `Bell` (client component, polls every 60 s, dropdown of the latest 8) and the page `/app/notifications` (latest weekly brief, recent list, settings).

## Preferences

`notification_preferences`: `in_app` (default on; off hides the bell and list), `email` (default off), `weekly_brief` (default on, but only emailed if `email` is also on), `quiet_types`. The email address is copied from the verified session when the user saves preferences, never from the request body, and is never returned by the API or logged. Unsubscribe is the link at the bottom of every email, which points at `/app/notifications`.

## Email

`email.ts`: `EmailProvider` interface; `resendProvider` posts to `https://api.resend.com/emails` with `fetch` when **`RESEND_API_KEY` and `EMAIL_FROM`** are both set; otherwise `disabledProvider` which never sends and reports "email disabled". Optional `APP_URL` is used to build absolute links in emails. With no provider nothing is queued; if rows were queued and the key is removed, the next outbox run marks them `disabled`.

Outbox (`email_outbox`, statuses `queued|sent|failed|disabled`): rows are claimed with `FOR UPDATE SKIP LOCKED` (attempts + 1 and a 10 minute lease), then become `sent`, go back to `queued` with exponential backoff (5 min, 10, 20, 40, ... capped at 6 h) on retryable errors (network, 429, 5xx), or `failed` after 5 attempts or on a non-retryable error. The Resend `Idempotency-Key` is the outbox row id. Emails are plain and short, with no tracking pixels, and every interpolated value is HTML-escaped. Provider error text never includes the response body.

## Scheduler (spec 71)

`startScheduler()` is called once from `instrumentation.ts` (Node runtime). It does nothing during `next build`, when `SCHEDULER_DISABLED=1`, or without `DATABASE_URL`, and is guarded against double start. It ticks every 10 minutes (`SCHEDULER_TICK_MS`); each tick runs `runDueJobs`, which takes a Postgres advisory transaction lock (`pg_try_advisory_xact_lock`) so only one instance runs jobs, and gates every job on its last run in `scheduled_runs(job, ran_at, ok, detail)`:

| Job | When | What |
| --- | --- | --- |
| `outbox` | hourly | process the email outbox |
| `reminder_sweep` | once per UTC day | for every business: build the system context, run the system automations, then a generic reminder for any other attention item due within 14 days (or overdue) or with severity `high` (dedupe key `reminder:<item id>:<due date>`) |
| `weekly_brief` | once per week (Monday UTC, or the first tick after) | generate the brief for every business |

Each business is handled in its own try/catch, so one failing business never stops the others. A failed run is recorded with `ok = false` and retried after 30 minutes. Everything is idempotent (dedupe keys, unique constraints), so retries and duplicate runs create nothing twice. `buildSystemContext(sql, businessId)` mirrors `lib/tools/context.ts` with role `owner`, user `system`, no AI (`available: false`) and no LegalAI summaries.

## Weekly brief (spec 29)

`weekly_briefs(business_id, week_start, content_md)`, unique per business and week (Monday UTC). Deterministic, no AI: needs attention (top 8), upcoming deadlines (14 days), overdue items (with an "overdue tasks" count), one line per tool from `describe()`, and the top 3 recommended next actions by severity then earliest due date. Shown on `/app/notifications`, announced with an in-app notification, and emailed to members who have email on, a stored address and `weekly_brief` on. `briefEnabled(businessId)` (`lib/notify/hooks.ts`, default true) is the plan hook: connect billing with `setBriefEnabledHook(async (id) => plan.features.weeklyBrief)`. Optional AI polishing of the text is future work and must not run in the scheduler.

## System automations (spec 32)

`automations.ts`. System-created only. Rules read **only `attention()` items** (`id`, `title`, `dueDate`, `severity`), recognising a tool's items by the tool id every attention id starts with. Each `(business, rule, key)` fires once (`automation_runs`, committed in the same transaction as the notification). Items a rule recognises are not reminded a second time by the generic sweep.

| Rule id | Fires | Once per |
| --- | --- | --- |
| `compliance-due-30` | a `compliance-*` item is due in 0 to 30 days | item + due date |
| `compliance-overdue` | a `compliance-*` item is past due | item + due date |
| `document-expiry` | a `vault-expiry-*` document expires in 30, then 14, then 3 days | item + due date + step |
| `document-expired` | a `vault-expiry-*` document has expired | item + due date |
| `task-overdue` | a `tasks-*` item is past its due date | task |
| `crm-stale` | a `crm-stale-*` item (open opportunity with no activity, the CRM's own threshold, 14 days by default) | opportunity per 28 days |

## Not built (future work)

- User-defined workflows and a builder UI (only the fixed system rules above exist).
- Quiet hours, digests (batching many notifications into one email), SMS and push.
- AI-polished brief text; brief generation as a visible background `Job` with progress (spec 71).
- Per-user read state for business-wide notifications; notification types beyond the dedupe-key prefix.
- Bounce and complaint handling from the email provider; a sending domain and `RESEND_API_KEY` are still needed to send anything.
