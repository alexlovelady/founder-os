# Integrations

Written from the code on 2026-10-03. Part 1 lists what exists. Part 2 lists integrations that are **planned and do not exist**: nothing in Part 2 is built, and no page or document may say it is. Spec reference: sections 31 (integrations) and 99 (moat).

## Part 1: what exists

| Integration | Required? | What it does | Where | Configuration |
|---|---|---|---|---|
| **LegalAI (module proxy and server-to-server API)** | Yes (it is also the sign-in provider) | The shell proxies the LegalAI UI under `/legal-ui` and `/assets`, signs users in with LegalAI accounts, creates and syncs each business's LegalAI workspace, runs AI jobs through `/api/inference`, and hands vault files over for review. | `shell/next.config.ts` (rewrites), `shell/src/lib/auth/legalai.ts`, `shell/src/lib/legal.ts`, `shell/src/lib/tools/ai.ts`, `shell/src/lib/legalbridge/` | `LEGAL_URL` on the shell (build argument for the rewrites, and read at runtime by server code). LegalAI side: see DEPLOYMENT.md. |
| **Private GPU node** | Yes for any AI | Pull agent on the owner's PC runs Ollama models. | `services/gpu-gateway/`, docs/gpu-node-windows.md | `GPU_NODE_TOKEN`, `GPU_NODE_ID` on the API service; `GATEWAY_TOKEN`, `API_URL`, `NODE_ID`, `GATEWAY_ALLOWED_MODELS` on the PC. See AI_SYSTEM.md. |
| **GitHub and GitLab.com (Product Scan)** | Optional (a tool feature) | Reads repository metadata and a capped set of files through the hosts' REST APIs. Only `github.com` and `gitlab.com` are accepted; only `api.github.com` and `gitlab.com/api/v4` are contacted. No git binary. Source code is never stored (structured result and short excerpts only). | `modules/product/` | None for public repositories (unauthenticated GitHub is limited to 60 calls an hour per server IP; a scan uses roughly 10 to 35). A user can paste a read-only personal access token for a private repository; it is stored encrypted (AES-256-GCM) only if `FOUNDEROS_SECRET_KEY` (32 random bytes, base64) is set, otherwise used for that scan only. Not a GitHub App and not OAuth. |
| **Brave Search API (competitor discovery)** | Optional | Competitor discovery results as web results to check. Fixed host `api.search.brave.com`. Without a key the AI may suggest names from general knowledge, labelled "Unverified suggestion, check the website". | `modules/competitors/` | `SEARCH_API_KEY` on the shell. Never returned to the browser or logged. |
| **Public web pages (competitor research)** | Built in | SSRF-safe, robots.txt-respecting fetcher for competitor pages the user lists. | `modules/competitors/src/safe-fetch.ts` | None. Rate limited per business (120 requests an hour, 30 s between runs on one competitor). |
| **Resend (email)** | Optional | Sends reminders, the weekly brief and notification emails through `https://api.resend.com/emails`, from a queued outbox with retries. With no key nothing is sent. | `shell/src/lib/notify/email.ts` | `RESEND_API_KEY` and `EMAIL_FROM` (both required), optional `APP_URL` for absolute links. Needs a Resend account and a verified sending domain (DNS records) that the owner controls. Team invites are not emailed; the invite link is shown once. |
| **Stripe (billing)** | Optional (inactive until keys exist) | Checkout, customer portal and webhooks for the Founder, Pro and Business plans. Without keys the billing page says billing is not enabled and every business gets the Business plan limits. | `shell/src/lib/billing/stripe.ts`, docs/BILLING.md | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_FOUNDER`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`, optional `STRIPE_TRIAL_DAYS`, `APP_URL`. Tested only against a faked Stripe layer; run a test-mode checkout before going live (BILLING.md has the steps). |

Inside LegalAI (not the shell) there are further optional outbound integrations, all documented in `modules/legal/`:

| Integration | Purpose | Configuration | Status |
|---|---|---|---|
| eCFR and GPO U.S. Code | Official federal regulation and statute text for the library | none (public APIs) | Verified against the live services per `legal-sources.md` |
| CourtListener | Court opinions for the library and the landmark cases | `COURTLISTENER_TOKEN` (free token) | The README says mock-tested only; `legal-sources.md` says verified live. Confirm with your token. |
| Voyage AI embeddings | External embeddings where a matter's privacy mode allows them | `EMBEDDING_API_KEY`, `EMBEDDING_PROVIDER=external` | Off for `local_only`; for `private` matters only if enabled per matter. Otherwise embeddings run locally on the GPU. |
| OpenAI-compatible external LLM fallback | Optional last-resort LLM when the GPU is off | `LLM_FALLBACK_*`, `EXTERNAL_LLM_MONTHLY_BUDGET_USD` | Off and consent-gated (AI_SYSTEM.md). No tool in the shell can enable it. |
| ClamAV (clamd) | Optional signature-based upload scanning | `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_REQUIRED` | Not deployed (RAM cost). Built-in upload checks are always on. |
| Tesseract OCR | Scanned documents | `OCR_ENABLED` (default true) | In the server image. |

Not integrations, but often assumed: there is **no Firebase** (accounts are interim LegalAI accounts), **no error monitoring** (`SENTRY_DSN` is not read by any code; Sentry was never wired), and **no analytics service** (product analytics are first-party rows in the shell database).

## Part 2: planned, not built

None of the following exists in the repository. There is no OAuth callback route, no token storage and no sync code for any of them. The `finance_connections_enabled` feature flag exists in the database (seeded off) as a switch for later, and does nothing today. Each integration is gated on the **owner** creating an account and registering an application with the provider; the assistant working on this repository cannot do that.

### What every OAuth integration would need in code
The same shape for all of them, so it should be built once:
* A table (shell migration, next free number) such as `integration_connections (business_id, provider, external_account_id, scopes, access_token_encrypted, refresh_token_encrypted, expires_at, status, connected_by, ...)` with `business_id NOT NULL REFERENCES businesses(id) ON DELETE CASCADE`. Token columns named with `encrypted` so the privacy export and admin views skip them (docs/DATABASE.md). Tokens encrypted with the same AES-256-GCM approach `modules/product` uses (business id as authenticated data), keyed by a key in the environment.
* Routes `GET /api/integrations/<provider>/connect` (build the authorization URL, with a random `state` stored server-side and checked on return, PKCE where the provider supports it) and `GET /api/integrations/<provider>/callback` (exchange the code, store encrypted tokens, record an audit event). Only owners and admins may connect. Disconnect deletes the tokens and asks the provider to revoke.
* A refresh helper that renews access tokens, marks a connection `needs_reauth` on failure and never logs tokens or provider response bodies.
* Sync jobs on the existing scheduler (`shell/src/lib/notify/scheduler.ts`; docs/NOTIFICATIONS.md), idempotent and per business, with a per-provider rate limit.
* A tool or tool section that reads the synced data through the usual `ToolDef` contract (facts, describe, attention, search, resolve), with the honesty rules in docs/TOOLS.md: say what was synced and when, never show data the provider did not return.
* Privacy: add each provider to the processor list on `/privacy` (draft, needs a lawyer), to the privacy export, and to the delete-business path so a business deletion also revokes tokens. Consider read-only scopes first.

### Google Drive, Gmail and Google Calendar
What the owner must do (the exact console steps and requirements change; check Google's current documentation before starting):
1. Create a Google Cloud project and enable the Drive, Gmail and Calendar APIs.
2. Configure the OAuth consent screen (app name, support email, privacy policy URL, authorized domain). The privacy policy at `/privacy` is currently a draft pending legal review and would need to be final.
3. Create an OAuth client of type "Web application" and add the redirect URI `https://<shell domain>/api/integrations/google/callback`. Provide the client id and secret to the shell as environment variables (names to be defined when the code is written, for example `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`).
4. Choose scopes. Gmail and broad Drive scopes are classed by Google as sensitive or restricted, and using them with accounts outside the owner's own organization can require Google's app verification and, for restricted scopes, an additional security assessment. Narrow scopes (calendar read-only, Drive "file" access to files the user picks) are much lighter. This is a real schedule and cost item to check before promising the feature.

Code that would be added: the common pieces above, plus a Drive picker or folder import into the Document Vault, a Calendar read that feeds deadlines into Tasks, and (if Gmail is chosen at all) a strictly opt-in, read-only mailbox search. No Gmail sending: sending a message on someone's behalf is the kind of action docs/TOOLS.md and the assistant rules keep behind explicit human confirmation.

### QuickBooks
What the owner must do: create an Intuit Developer account and an app, copy the client id and secret, add the redirect URI `https://<shell domain>/api/integrations/quickbooks/callback`, and note that production keys are issued after Intuit's own app assessment questionnaire. Start in the Intuit sandbox company.
Code that would be added: the common pieces plus a read-only import of accounts, invoices and balances into the Finance tool, so the runway calculator and Business Health can use real figures. Tokens at Intuit are short-lived and the refresh token rotates, so refresh storage must be transactional. No writing to the ledger.

### Plaid
What the owner must do: create a Plaid account, obtain the client id and secrets, and apply for production access (Plaid reviews the use case, and bank connections in production are billed). Configure the allowed redirect URI (for OAuth banks) and the Link customization. Bank data is highly sensitive: the draft privacy policy and security page would need to cover it, and the owner should decide on retention before turning it on.
Code that would be added: a server route that creates a Plaid Link token, a client component that opens Plaid Link, a server route that exchanges the public token for an access token (stored encrypted), and a transactions and balances sync into the Finance tool. Reading only; no payment initiation.

### Also not built
Other providers (Slack, HubSpot, Notion, e-signature services), webhooks into or out of the product, a public API or API keys for customers, a Zapier-style automation builder (only the fixed system rules in docs/NOTIFICATIONS.md exist), and Sentry or any error-reporting service.
