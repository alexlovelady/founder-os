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

## Identity and tenancy
**Current (interim):** the shell signs users in with LegalAI's existing accounts (email, password, optional two-step). The shell hides this
behind `IdentityProvider` (`shell/src/lib/auth/provider.ts`), so pages never depend on it. The shell proxies LegalAI under `/legal-ui`
(see `shell/next.config.ts`), which means the browser sees one origin: one sign-in cookie, and LegalAI pages embed in a same-origin
frame. LegalAI frames itself only for its own origin plus anything in `EMBED_ORIGINS`.
The shell gate runs on the server (`getSession`), not in the browser.

**Target:** a shell-owned identity (Firebase Auth per the spec) with users, businesses and memberships, and signed per-business module
tokens (see Module contract). Swap the `IdentityProvider` and add token verification to LegalAI; pages stay unchanged.

Known limits of the interim setup: one global user table owned by LegalAI, no businesses or roles in the shell yet, accounts are created
by the LegalAI administrator.

## AI tiers
`free/founder` use the private GPU, `pro+` may use cloud models or a customer-supplied key. Implemented as configuration in the shell
(plan -> provider policy) and passed to modules in the token; see ROADMAP.

## Decisions recorded
* Monorepo, one folder per module (chosen 2026-10-03).
* Local GPU only until paid AI tiers ship (chosen 2026-10-03).
* LegalAI stays Python; it is not rewritten into the shell's stack.
