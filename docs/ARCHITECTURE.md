# Architecture

## Principles
1. **The shell owns the customer; modules own the work.** The shell (Next.js) handles identity, businesses, plans, billing and the
   dashboard. Each module is an independent service with its own folder, API, data, tests and deploy. A module never imports another
   module's code.
2. **Modules plug in through a contract, not through code sharing.** See "Module contract" below. Adding or upgrading a module means
   changing one folder.
3. **One business = one tenant everywhere.** Every module request carries a verified `businessId`. Modules refuse requests without it.
4. **Provider-agnostic AI.** Modules ask for a *model tier* (`fast`, `deep`); a plan decides which provider serves it (private GPU now;
   cloud or the customer's own key later). Modules never hard-code a provider.

## Folders
| Folder | What | Stack | Deploys as |
|---|---|---|---|
| `shell/` | SaaS shell | Next.js, TypeScript | its own Vercel/Railway service |
| `modules/legal/` | LegalAI | FastAPI, Postgres+pgvector, React | Railway service `api` (live today) |
| `services/gpu-gateway/` | Private GPU agent | Python | runs on the owner's PC |

## Module contract (v1)
A module exposes, under its own base URL:
* `GET /healthz`: liveness.
* `GET /module.json`: `{ id, name, version, entrypoints[], capabilities[] }` so the shell can build navigation without code changes.
* Authenticated calls carry `Authorization: Bearer <shell-issued token>` (short-lived, signed by the shell; claims: `sub` user id,
  `bid` business id, `role`, `plan`, `exp`). The module verifies the signature with the shell's public key and trusts nothing else.
* The module may be shown in the shell as an embedded page (iframe or route) or called via API from shell pages.
* Usage events (`ai_requests`, tokens, documents) are reported back so the shell can enforce plan limits and show cost.

## Identity and tenancy (target)
Shell authenticates the user (Firebase Auth per spec), stores users/businesses/memberships, and mints module tokens. LegalAI today has
its own users and "matters"; the adapter work (Phase 2 of the roadmap) maps a shell business to a LegalAI workspace and accepts shell
tokens, keeping its existing login for standalone use.

## AI tiers
`free/founder` use the private GPU, `pro+` may use cloud models or a customer-supplied key. Implemented as configuration in the shell
(plan -> provider policy) and passed to modules in the token; see ROADMAP.

## Decisions recorded
* Monorepo, one folder per module (chosen 2026-10-03).
* Local GPU only until paid AI tiers ship (chosen 2026-10-03).
* LegalAI stays Python; it is not rewritten into the shell's stack.
