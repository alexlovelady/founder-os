# Team collaboration

Code: `shell/src/lib/team`, `shell/src/app/app/team`, `shell/src/app/invite`, `shell/src/app/api/team`, `shell/src/components/team`, migration `shell/migrations/0006_team.sql`.

## Roles
Defined once in `shell/src/lib/team/permissions.ts` (pure, tested in `shell/tests/team`).

| Permission | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| View team | yes | yes | yes | yes |
| Invite (roles) | admin, member, viewer | member, viewer | no | no |
| Revoke invites | yes | yes | no | no |
| Change roles | anyone but self | members and viewers only | no | no |
| Remove members | anyone but self | members and viewers only | no | no |
| Edit business profile | yes | yes | no | no |
| Transfer ownership, delete business, billing | yes | no | no | no |
| Tools | read + write | read + write | read + write | read only |

Invariants (enforced in the transaction, with the business row locked):
* A business always has at least one owner (the last owner can neither be demoted, removed nor leave).
* Admins cannot demote or remove an owner or an admin, and cannot make anyone owner or admin.
* Nobody changes their own role. Owners are not invited: an owner transfers ownership (target becomes owner, the old owner becomes admin) or promotes a member.
* Every action re-reads the caller's role from the database and only touches members of the caller's current business.

## Invites
No email is sent (no provider yet). An owner or admin creates an invite (role, optional email restriction, expiry 1 to 30 days, default 7, uses 1 to 50, default 1) and gets a link `/invite/<token>` **once**. Only the SHA-256 hash is stored (`team_invites.token_hash`); lost links cannot be recovered, revoke and create another. Hashes are compared in constant time.

Accepting requires being signed in. Signed-out visitors are sent to `/login?next=/invite/<token>`. Accept checks: not revoked, not expired, uses left, email match (if restricted, case-insensitive), not already a member, plan seat limit. The membership insert and use-count bump run in one transaction with the business and invite rows locked, so concurrent accepts cannot exceed `max_uses` or the seat limit.

## Account-creation caveat
Accounts live in LegalAI (the interim identity provider) and only a LegalAI administrator can create them. The shell cannot create accounts. An invitee must already have an account (or ask the administrator for one) before opening the link. The shell only learns the signed-in user's id, email, display name and role, so it stores `email` and `display_name` in `team_member_profiles`, refreshed for the current user on every team page / API call; members the shell has never seen signed in show their user id.

## Limits
* Seats = number of members. The plan limit is passed to `acceptInvite(sql, { token, user, seatLimit })` (`null` = unlimited). `seatLimitFor()` in `lib/team/server.ts` is the single place to wire billing.
* At most 50 open invites per business.

## Multiple businesses
`ACTIVE_BUSINESS_COOKIE` (`fos_business`) remembers the active business; `getActiveBusinessId(userId, cookieValue)` trusts it only for memberships and otherwise falls back to the oldest business. `BusinessSwitcher` posts to `POST /api/team/active`.

## API (`/api/team`)
`GET /` team, `POST|GET /invites`, `DELETE /invites/[id]`, `PATCH|DELETE /members/[userId]`, `POST /leave`, `POST /transfer`, `POST /active`, `POST /accept`. Mutations check `Origin` against `Host`.

## Not built
Email delivery of invites, guest roles (accountant/attorney with per-section sharing), per-tool role overrides, audit logging (functions return before/after values for the caller to log), a billing-aware seat limit.
