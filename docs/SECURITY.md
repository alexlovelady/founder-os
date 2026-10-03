# Security: what exists today

Written from the code on 2026-10-03. If a control is not listed as "exists", assume it does not. Spec reference: build spec sections 37-41.

## Authentication and sessions
* **Exists.** Sign-in uses LegalAI accounts (`shell/src/lib/auth/legalai.ts`, behind `IdentityProvider`). LegalAI hashes passwords with Argon2, supports
  optional two-step sign-in with recovery codes, and issues an `httponly`, `SameSite=lax` session cookie (`secure` when `COOKIE_SECURE=true`).
  Login attempts are rate limited in LegalAI (10 per 5 minutes).
* The shell checks the session on the server for every page and API route (`getSession()` in `shell/src/lib/auth/server.ts` calls LegalAI `/api/auth/me`).
  Nothing relies on hiding things in the browser.
* **Gaps.** Accounts are created by the LegalAI administrator (no self sign-up, no password reset flow in the shell). The target is a shell-owned
  identity (see docs/ARCHITECTURE.md). Account deletion is not possible from the shell (`POST /api/privacy/delete-account` returns 501).

## Tenant isolation and roles
* **Exists.** `buildContext` (`shell/src/lib/tools/context.ts`) derives the business and role from the verified session membership
  (`business_members`), never from the request. Every tool query filters by `ctx.businessId`; every tool table has
  `business_id NOT NULL REFERENCES businesses(id) ON DELETE CASCADE`. Tool tests check isolation with a second business.
  Writes call `requireWrite(ctx)` (viewers are read only).
* Business profile edits and privacy settings require owner/admin; deleting the business requires owner.
* **Gaps.** One business per user is assumed in the current helpers (`currentBusiness` picks the first membership). Invites and role management
  are being built separately. There is no row-level security in Postgres: isolation is enforced in application code and tests.

## Platform admin
* **Exists.** `/admin` and `/api/admin/*` require the LegalAI role `admin` on the verified session; anyone else gets a 404 (pages call `notFound()`,
  APIs return 404). Admin pages show counts, profile data and audit only: no document contents and no row-level tool data.
  Admin changes (feature flags, flag overrides, feedback status) and business detail views are written to the audit log.
* **Gap.** Admin is a single global role; there is no separate admin MFA requirement beyond what the LegalAI account has.

## CSRF
* **Exists.** Platform write endpoints (`/api/privacy/*`, `/api/feedback`, `/api/events`, `/api/admin/*`) reject a request whose `Origin` header does not match the `Host`
  (`shell/src/lib/platform/http.ts`), on top of the `SameSite=lax` cookie. LegalAI uses its own CSRF token header.
* **Gap.** The generic tool API route (`/api/tools/<tool>/...`) and `/api/business` do not check `Origin`; they rely on `SameSite=lax` and JSON bodies.

## Security headers
* **Prepared, not yet wired.** `shell/src/lib/platform/security-headers.ts` exports `securityHeaders()` for `next.config.ts` `headers()`:
  Content-Security-Policy, X-Content-Type-Options `nosniff`, X-Frame-Options `SAMEORIGIN`, Referrer-Policy `strict-origin-when-cross-origin`,
  Permissions-Policy (camera, microphone, geolocation, payment, usb off), and HSTS in production.
* The CSP is static (no nonce): `default-src 'self'`; `script-src 'self' 'unsafe-inline'` (Next.js inline bootstrap scripts; `'unsafe-eval'` only in development);
  `style-src 'self' 'unsafe-inline'`; images `self data: blob:`; `connect-src 'self'`; `frame-src 'self'` and `frame-ancestors 'self'` (LegalAI is framed through the
  same-origin `/legal-ui` proxy); `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`. No wildcard or third-party origins. Because of `'unsafe-inline'`
  for scripts, the CSP limits where resources load from but does not stop injected inline script; a nonce-based CSP via `proxy.ts` is the stricter next step.
* LegalAI sets its own stricter CSP and frame rules (`modules/legal/api/legalai/middleware.py`). Proxied responses carry both; the browser enforces both.

## Uploads and downloads (Vault)
* **Exists** (`modules/vault/src/files.ts`, `index.tsx`): allow-list of extensions (pdf, docx, doc, xlsx, csv, txt, md, png, jpg, jpeg, webp), 15 MB cap,
  byte-signature check against the extension, refusal of executable signatures, filename sanitizing, content stored in Postgres with a SHA-256 and metadata in separate columns.
  Downloads are scoped by business, sent as attachments with a fixed safe content type, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `no-store`.
* **Gaps.** No malware scanning. No signed or expiring download links (access is by session and business membership). Files are stored in the database, so they are in the same backup scope.

## SSRF protections
* **Exists** for the competitor research fetcher (`modules/competitors/src/safe-fetch.ts`): https only on the default port, one DNS resolution that is checked and then connected to,
  private/loopback/link-local/metadata/reserved IPv4 and IPv6 refused, re-checked on each of at most 3 redirects, size/time/content-type caps. LegalAI has its own `safe_fetch.py` for library sources.
* **Gap.** Any new feature that fetches user-supplied URLs must use these helpers; nothing enforces that automatically.

## Input validation and rate limiting
* **Exists.** Request bodies are parsed with zod (`readJson` in the SDK; platform routes use `safeParse`). Feedback is limited to 10 per hour per user (counted in the database,
  serialized per user). LegalAI has in-process rate limits (600 requests/minute general, 60/minute for heavy routes, 10 logins per 5 minutes).
* **Gaps.** The shell has no general rate limiter for its own API routes. LegalAI's limiter is in memory (per instance).

## Audit log
* **Exists.** Table `audit_events` (migration 0003). `recordAudit` (`shell/src/lib/platform/audit.ts`) never throws, drops metadata keys that look like secrets
  (password, token, secret, key, authorization, cookie, credential, session, csrf, bearer, signature), truncates long values and caps size. Recorded today by platform code:
  privacy export, privacy settings change, business deletion, admin actions. Tools write through `ctx.audit(...)`.
* **Gaps.** `ctx.audit` is a no-op until the lead wires it to `recordAudit` in `buildContext`; login/logout and many tool actions are not yet recorded. Audit rows are not tamper-evident
  and have no retention policy. Deleting a business removes that business's audit rows (the deletion event itself is kept without the business name).

## Privacy controls
* **Exists.** `GET /api/privacy/export` (owner/admin) returns JSON of the business profile, members, privacy settings, links, every `<toolid>_*` table (rows for that business),
  and platform tables, leaving out binary columns (document bytes) and columns named like token/secret/password/encrypted. `POST /api/privacy/delete-business` (owner, must type the business name)
  deletes the business and cascades to all tool rows. `GET/PUT /api/privacy/settings` stores the AI data-use note and product analytics opt-out (honored by `trackEvent`).
* **Gaps.** Deleting the business does not delete LegalAI workspace data, the LegalAI account, or Railway database backups. Account deletion is not implemented. Retention settings are not built.
  There is no UI page for these yet.

## Secrets and logging
* Secrets come from server environment variables only; none are in the frontend bundle. Platform code logs only error names/codes, never payloads. LegalAI access logs exclude bodies, query strings and cookies.

## Backups and recovery (honest status)
* LegalAI has a backup module (`modules/legal/api/legalai/backup.py`, `/api/admin/backup`, enabled by `BACKUP_ENABLED`) for its own database and storage.
* The shell database (`Postgres` on Railway) has no backup automation in this repository. docs/railway.md says to enable Railway Postgres backups and do a restore test; **that has not been verified or
  documented as done**. Treat shell data (businesses, vault documents, CRM, audit) as not yet backed up until that is confirmed.

## Not built
Dependency scanning in CI, malware scanning, signed download URLs, per-tenant encryption keys, Postgres row-level security, nonce-based CSP, admin MFA enforcement, retention settings, error monitoring (needs a DSN).
