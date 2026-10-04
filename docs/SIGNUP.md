# Self-serve signup

Written 2026-10-03. Accounts still live in LegalAI (the interim identity provider, see docs/ARCHITECTURE.md "Identity and tenancy"). Signup lets the shell ask LegalAI to create an ordinary account.

## How it works
1. Visitor opens `/signup` (public). The page depends on `SIGNUP_MODE`.
2. The form posts to `POST /api/signup` (shell). The shell validates with zod, checks the mode, rate limits, takes one use of the invite code (when required), then calls LegalAI **server to server**: `POST {LEGAL_URL}/api/internal/users` with header `X-Internal-Token`.
3. LegalAI creates a normal non-admin user (Argon2 hash, lower-cased unique email) and writes the audit event `auth.user_created_internal`. It returns only `{id}`. It never creates a session. In `open` mode the shell sends `active: false` (only honored on this token-gated endpoint) so the account cannot sign in until the emailed link is used.
4. The shell answers success and the page sends the visitor to `/login?created=1` (in `open` mode to `/verify?sent=1`, "check your email"). There is no automatic sign-in (keeps the token and the sign-in path separate).
5. If LegalAI does not create the account (any failure, duplicate email, timeout) the invite code use is given back.

## Environment variables
| Variable | Where | Meaning |
|---|---|---|
| `INTERNAL_PROVISION_TOKEN` | **shell and LegalAI, same value** | Shared secret, 32+ random characters (for example `openssl rand -base64 36`). On LegalAI it is the setting `internal_provision_token`. If unset or shorter than 32 characters, LegalAI answers 404 to `/api/internal/*` and the shell answers 503 "Signup is not available". |
| `SIGNUP_MODE` | shell | `closed` (default; anything else unrecognised is closed), `invite`, `open`. |
| `LEGAL_URL` | shell | Already exists. Use the private/internal LegalAI address if the platform has one. |
| `SIGNUP_HASH_SECRET` | shell, optional | Key for the hashes in `signup_attempts`. Falls back to `INTERNAL_PROVISION_TOKEN`. |
| `SIGNUP_TRUSTED_PROXY_HOPS` | shell, optional, default `1` | How many proxies sit in front of the shell. The client IP is taken from the right-hand side of `X-Forwarded-For` (the left side is client controlled). Set it wrong and rate limits either merge everyone into one bucket (too high a hop count is harmless, too low merges visitors behind the proxy). |

Set `TRUST_PROXY=true` on LegalAI behind a proxy as it already does for other limits.

## Modes
* **closed**: the page says access is by invitation and signup returns 403.
* **invite**: a valid code is required. Admins create codes at `/admin/signup`.
* **open**: anyone can sign up, rate limited, and **must confirm their email address** before the account works (see docs/ACCOUNTS.md): the account is created inactive and a `/verify/<token>` link is emailed. If email is not configured (`RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`) `open` refuses all signups ("Open signup needs email verification, which is not configured"), so it can never run unverified. Unconfirmed accounts are deleted after 7 days by the scheduled `purgeUnverified`. Remaining risk: verification proves control of an address, not that the person is real, and bots with throwaway mailboxes pass it (5 signups per IP and 3 per email per hour); accounts get GPU/AI access, so **a CAPTCHA or similar is still advisable before leaving `open` on.** The admin page shows a warning when it is on.

## Invite codes
Table `signup_codes` (migration `0008_signup.sql`): hash only (SHA-256 of the upper-cased, punctuation-stripped code), label, max uses, use count, expiry, created by, revoked at. The raw code (`FOS-XXXXX-XXXXX-XXXXX-XXXXX`, about 98 bits) is shown once. Consumption is one conditional `UPDATE ... WHERE use_count < max_uses AND not revoked AND not expired`, so concurrent signups cannot both take the last use. Revoking is soft (the row stays). Admin create and revoke are audited (`admin.signup.code_created`, `admin.signup.code_revoked`); the raw code is never audited.

## Rate limits and attempt log
`signup_attempts` stores an HMAC-SHA-256 of the IP and of the email (never raw values), the outcome and the time. Limits are counted from the table, serialized with advisory locks: **5 per IP hash per hour, 3 per email hash per hour**. Every attempt counts, including failures. Rows older than 30 days are pruned opportunistically. LegalAI also limits its endpoint: wrong-token guesses (20 per 5 minutes per IP, then 429), the shared heavy limiter (60 per minute) and an overall 60 per 10 minutes per source IP.

## "Already registered"
A signup flow cannot avoid telling a person that their email is taken. The message is generic ("An account with this email already exists") and the per-email and per-IP limits slow down enumeration. The shell answers 409 and gives the invite code back.

## The private LegalAI endpoint
`POST /api/internal/users`: hidden from OpenAPI, body `{email, password (12+), display_name}` and nothing else (a `role` field is a 422), returns `{id}` or 409. It is not reachable by browsers in practice because they never have the token: **the token must never reach the browser** (no `NEXT_PUBLIC_` prefix, never returned by any API, never logged; the shell only reads it in server code and never forwards the visitor's headers to LegalAI).

### Proxy exclusion the lead must add (`shell/next.config.ts`)
The shell proxies `/legal-ui/:path*` to LegalAI, which would expose `/legal-ui/api/internal/users` to the internet (still protected by the token, but it should not be reachable at all). Add a rule before the proxy rewrite that sends it nowhere, for example in `rewrites()` ahead of the `/legal-ui/:path*` entry:

```ts
{ source: "/legal-ui/api/internal/:path*", destination: "/404" },
```

(a rewrite to a path that does not exist makes Next.js answer 404; it must come BEFORE the `/legal-ui/:path*` rule). Verify with `curl -i -X POST https://<shell>/legal-ui/api/internal/users` returning 404 from the shell. Also do not expose LegalAI's own public domain if the platform allows a private network, or block `/api/internal/` at its edge.

## What is not built
* Email verification, password reset and account deletion are built: see docs/ACCOUNTS.md. Invite-mode addresses are not verified (the invite code is the gate).
* Auto sign-in after signup, CAPTCHA, a business created at signup (the user creates their business after first sign in as before).
* The draft Terms page still says "Accounts are created by an administrator" (owned by the site/SEO work; update when signup goes live).

## Security notes
* Token compared with `hmac.compare_digest`; endpoint 404s when unconfigured (even for malformed bodies); constant 401 for wrong tokens.
* Passwords and tokens are never logged or put in audit metadata; the shell audit helper also strips secret-like keys. The shell does not store the email or name anywhere for signup beyond the LegalAI account.
* If LegalAI creates the account but the response is lost (timeout), the code use is restored and a retry gets 409 "already exists"; an administrator can reissue a code.
* `Origin` must match `Host` on `POST /api/signup` (same check as other platform writes); request bodies over 8 KB are refused.
* Tests: `modules/legal/api/tests/test_internal_signup.py` (pytest) and `shell/tests/signup/signup.test.ts` (vitest).
