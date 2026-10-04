# Account lifecycle: password reset, email verification, account deletion

Written 2026-10-04. Accounts still live in LegalAI (the interim identity provider). The shell drives these flows and calls LegalAI over the private, token-gated `/api/internal/users/*` endpoints (same `INTERNAL_PROVISION_TOKEN` as signup, see docs/SIGNUP.md). Code: `shell/src/lib/lifecycle/`, `modules/legal/api/legalai/routers/internal.py`, `modules/legal/api/legalai/lifecycle.py`. Migration: `shell/migrations/0009_lifecycle.sql`.

## Email requirement
Reset, verification (and therefore `open` signup) need email. "Email is configured" means **`RESEND_API_KEY` and `EMAIL_FROM` and `APP_URL`** are all set (links in mail must be absolute). Mail goes through the existing outbox (`email_outbox`, `enqueueEmail(sql, null, ...)` with no business) and is sent immediately by a best-effort outbox run; the hourly outbox job retries failures. No lifecycle email is ever queued when email is not configured.

## Password reset
| Flow | Where | Token life |
|---|---|---|
| Self-serve | `/forgot` posts `{email}` to `POST /api/account/forgot` | 30 minutes |
| Admin-created | `/admin/users` "Create reset link" calls `POST /api/account/admin-reset-link` (platform admin only, 404 for anyone else) | 24 hours |
| Using a link | `/reset/<token>` (form: new password + confirm + strength hint) posts to `POST /api/account/reset` then redirects to `/login?reset=1` | |

* **No enumeration.** `/forgot` returns the same message for a known and an unknown address ("If an account exists..."), including when LegalAI is down or the per-email limit is hit. Only a malformed address (400) and the per-IP limit (429) differ. The mail is sent in the background so response time does not reveal an account.
* **Email not configured:** the page says "Password reset by email is not available yet. Ask your administrator for a reset link." and nothing is created or looked up.
* **Tokens:** 256 random bits, only the SHA-256 is stored (`password_reset_tokens.token_hash`); `created_by` is `self` or `admin:<id>`. The admin link is shown once on screen (as a path; the browser adds the origin) and never stored raw. Tokens, passwords and addresses are never logged or put in audit metadata.
* **Single use under concurrency:** the token is claimed with one conditional `UPDATE ... WHERE used_at IS NULL AND expires_at > now()`. The password is validated before the claim (a typo does not burn the link). If LegalAI cannot set the password the claim is given back; if the account no longer exists the link stays spent. After success every other outstanding link for that user is revoked.
* **LegalAI side:** `POST /api/internal/users/{id}/password` sets a new Argon2 hash (12+ characters), **revokes every session of that user**, does **not** touch MFA (secret, enabled flag and recovery codes stay; the user still needs their second factor to sign in; the reset page says so), writes the audit event `auth.password_reset_internal`, returns `{ok:true}` only. `POST /api/internal/users/lookup {email, include_inactive?}` returns `{id}` or a plain 404 (never finds deleted accounts; 30 per 10 minutes per source IP).
* **Admin takeover note:** an administrator who creates a link can set that person's password (but not bypass MFA). The shell cannot tell which users are admins, so this applies to every user including other admins. Every link creation is audited (`admin.user.reset_link_created`, actor, target, no token).

## Email verification (open signup)
* `SIGNUP_MODE=open` now **requires verification**. If email is not configured, signup answers 503 "Open signup needs email verification, which is not configured. Ask the administrator." and `/signup` shows the same; the login page and `/api/signup/status` do not offer it. So `open` can never run unverified.
* The shell creates the LegalAI user **inactive** (`active: false`, an optional field of the internal create endpoint only; inactive users cannot sign in), stores `email_verifications` (user id, token hash, 24 hour expiry, used_at; **the address is not stored there**), queues the mail with a `/verify/<token>` link and sends the person to `/verify?sent=1` ("Check your email", with a resend form).
* `/verify/<token>` posts the token to `POST /api/account/verify` on load (a POST so a mail scanner that merely fetches the link cannot use it up). LegalAI `POST /api/internal/users/{id}/activate` activates the account; the person lands on `/login?verified=1`. Single use, same claim/release logic as reset.
* Resend: `POST /api/account/resend-verification {email}` gives a generic answer. It only mails an account that LegalAI reports inactive **and** for which an unused verification record exists, so it cannot touch accounts disabled for other reasons.
* `invite` mode is unchanged (the invite code is the gate, no verification). `closed` unchanged.
* **Cleanup (the lead must schedule it):** `purgeUnverified(sql, deps)` in `shell/src/lib/lifecycle/verify.ts`. Daily is enough. It deletes accounts whose earliest verification record is older than 7 days and never used, by calling `DELETE /api/internal/users/{id}?only_inactive=true` (LegalAI answers 409 if the account became active, so a confirmed account can never be deleted by it), removes their token rows, and deletes finished lifecycle mail (sent/failed/disabled, older than 2 days) from the outbox. `pruneLifecycle(sql)` (same folder, `limits.ts`) trims the attempt log and spent reset tokens; it is also called opportunistically.

## Account deletion
`POST /api/account/delete` (signed in, same-origin; the old `POST /api/privacy/delete-account` now serves the same handler instead of 501). Body: `{confirmEmail, password}`. UI: "Delete your account" on `/app/privacy`.

1. The typed email must equal the account email (case-insensitive) and the **current password is re-checked** through `POST /api/internal/users/{id}/verify-password` (creates no session, does not touch MFA, 5 per 5 minutes per user in LegalAI, 5 per hour per account in the shell). If the account is the only active platform administrator the request is refused first.
2. One transaction with the businesses locked:
   * the person is **sole owner of a business that has other members**: refused with the business names ("transfer ownership or remove the other members first"); nothing at all is changed;
   * the person is the **only member**: the business is deleted with all its tool data (same code as "delete business": `purgeBusinessRows` in `lib/platform/privacy.ts`, ON DELETE CASCADE);
   * otherwise only the membership (and team profile) is removed.
3. LegalAI `DELETE /api/internal/users/{id}`: revokes all sessions; sets `deleted_at` and `is_active=false`; replaces the email with `deleted-<uuid>@invalid`, the name with "Deleted user" and the password hash with a hash of a random secret; deletes MFA secret and recovery codes and the user's personal playbooks; scrubs the address from failed-login audit detail; **hard purges every ordinary matter the user solely owns** (no other live member): stored files are removed first (every `storage_key`, then anything left under `matters/<id>/`), and only if that succeeds the rows (matter, documents, versions, chunks, embeddings, jobs, research runs, drafts, reviews, redlines ...) are deleted by cascade. It is idempotent and safe to retry; if a file cannot be removed it returns 500 and leaves the rows so a retry finishes the job. Matters shared with other live users are left untouched (the user's membership is dropped, except where they are the only owner, which stays so it stays traceable). There is **no grace period**: the confirmation says it cannot be undone.
4. The shell then removes personal rows: team profiles, notification preferences and notifications, feedback, suspension record, reset/verification tokens, every outbox mail addressed to the address; analytics and usage events lose their user id.
5. If step 3 fails after step 2, the person gets a 502 and can repeat the request (their session is still valid; the route does not need a business).

### What is deleted / what is not
Deleted: the account identity and credentials, sessions, MFA, solely owned LegalAI matters with files and indexes, businesses with no other member, memberships, personal shell rows listed above.
**Not deleted:** audit log entries (they keep only the pseudonymous user id, no address; business audit rows go with their business); `provider_usage` rows (token counts and cost, no content); `created_by` ids inside tool rows of businesses the person left (the id no longer maps to anyone); anything shared with other people; the `users` row itself (anonymized, kept so references stay valid); **database and volume backups, which keep data until they rotate**. Shell-side data in businesses the person owned and deleted is gone from the live database but also persists in backups until rotation.

## Abuse limits
| Where | Limit |
|---|---|
| `/api/account/forgot`, `/api/account/resend-verification` | per client IP 5 / 10 min (proxy, `classify.ts`); DB: 5 per hashed IP and 3 per hashed email per hour (per-email is silent) |
| `/api/account/reset`, `/api/account/verify` | per client IP 10 / 10 min; DB: 20 and 30 per hashed IP per hour |
| `/api/account/delete` | per client IP 5 / 10 min; DB: 10 per hashed IP and 5 per hashed account per hour |
| `/api/account/admin-reset-link` | per client IP 20 / 10 min, admin only |
| `/forgot`, `/verify`, `/reset/*`, `/verify/*` pages | 30 / min per IP **only if** `src/proxy.ts` `matcher` includes them (see below) |
| LegalAI internal endpoints | wrong-token guesses 20 / 5 min, lookups 30 / 10 min per source IP, password re-checks 5 / 5 min per user, plus the existing general caps |

All limits count every attempt, use keyed HMAC hashes (`SIGNUP_HASH_SECRET`, falling back to `INTERNAL_PROVISION_TOKEN`) so no raw email, IP or user id is stored in `lifecycle_attempts`, and share the proxy-hop rules of signup (`SIGNUP_TRUSTED_PROXY_HOPS`).

## Environment variables
`INTERNAL_PROVISION_TOKEN` (shell and LegalAI, 32+ chars; without it all of this answers 404/503), `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL` (email), `SIGNUP_MODE`, `SIGNUP_HASH_SECRET`, `SIGNUP_TRUSTED_PROXY_HOPS`, `LEGAL_URL`. Nothing new on LegalAI.

## Needs the lead
* Schedule `purgeUnverified(db(), {})` (daily) and optionally `pruneLifecycle(db())`.
* Add `/forgot`, `/verify`, `/reset/:path*`, `/verify/:path*` to the `matcher` in `shell/src/proxy.ts` (the rate rules for them already exist in `classify.ts`; without the matcher only the API routes are limited).
* `/legal-ui/api/internal/:path*` must stay blocked at the shell (docs/SIGNUP.md).
* Tests: `modules/legal/api/tests/test_internal_lifecycle.py`, `shell/tests/lifecycle/*.test.ts`.

## Not built
CAPTCHA, resending to a changed address, changing email or password while signed in, session list UI, ownership transfer wizard from the deletion screen (use the team page), a grace period / undelete, notifying the person by email after a reset or deletion, bounce handling.
