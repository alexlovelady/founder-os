# What is left, and who can do it

Source: docs/FounderOS_Build_Spec.md and docs/ROADMAP.md. Updated 2026-10-03.

## Being built now (no input needed from the owner)
| Area | Spec sections | Owner folder(s) |
|---|---|---|
| Audit log, privacy controls (export / delete), admin portal, feature flags, feedback, product analytics | 40, 41, 45, 46, 73, 74 | shell/src/lib/platform, shell/src/app/admin, api/admin, api/privacy, migration 0003 |
| Notifications, daily scheduler, weekly business brief, system automations, email provider (off until a key exists) | 28, 29, 32, 71, 72 | shell/src/lib/notify, app/notifications, migration 0004 |
| Plans, usage metering and limits, Stripe checkout / portal / webhooks (code complete, inactive until keys exist) | 33-36 | shell/src/lib/billing, app/billing, migration 0005 |
| Team: invites, roles, member management | 7, 59 | shell/src/lib/team, app/team, migration 0006 |
| Public site, pricing, free tools, trust pages, SEO | 80, 81, 93, 94 | shell/src/app/(site) |
| Vault text extraction, summaries, hand-off to LegalAI review | 14, 17, 56 | modules/vault |
| Assistant actions with confirmation (create task, add contact, mark done ...) | 12 | modules/sdk (actions), modules/founderai, small additions in tools |
| Mobile layout, notification bell, plan wiring | 69, 43, 44 | shell layout (lead) |
| CI, seed demo data, remaining docs, end-to-end tests | 66, 67, 86, 90 | .github, scripts, docs, e2e |

## Cannot be finished without the owner
| Item | Why | What the owner does |
|---|---|---|
| Stripe live billing | needs a Stripe account, products and keys | create the account, give keys through Railway variables (docs/BILLING.md) |
| Email sending (reminders, weekly brief, invites) | needs an email provider key and a sending domain | Resend account + domain DNS records |
| Google Drive / Gmail / Calendar, QuickBooks, Plaid | each needs an OAuth app registered in the owner's account | register apps; then the integration code can be added |
| Firebase auth | owner chose to keep LegalAI accounts for now | revisit later |
| Custom domain and subdomains | needs DNS access | add DNS records in Railway |
| Error monitoring (Sentry) | needs a project DSN | create the project, set `SENTRY_DSN` |
| Professional review of Terms, Privacy, AI disclosure | must be a lawyer | engage counsel; the pages are drafts until then |
| Cloud / bring-your-own-key AI tiers | owner deferred | later |
| Competitor discovery search | optional `SEARCH_API_KEY` (Brave) | create key |
| Remove the empty extra Railway database | a delete was blocked for the assistant | delete `Postgres--1wG` in Railway |
| First production account | account creation is not something the assistant may do | bootstrap at the LegalAI address |
