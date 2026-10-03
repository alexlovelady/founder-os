# Product Scan (`product`)

Link a GitHub or GitLab repository and FounderOS works out what the product is, what stack it uses, and which business and legal topics deserve a look. It uses the hosts' REST APIs (there is no git binary), reads a small capped set of files, and keeps only a structured result plus short excerpts. It never stores source code.

## What is live
- Link `https://github.com/<owner>/<repo>` or `https://gitlab.com/<group>/<project>` (subgroups ok). The URL is parsed strictly; only `github.com` and `gitlab.com` are accepted and only the fixed API hosts (`api.github.com`, `gitlab.com/api/v4`) are ever contacted. Redirects are followed only on the same fixed host.
- Scan: metadata, languages, license, default branch, 90-day commit count, last commit date, contributors, file tree (top level stored, whole tree used for signals, capped at 3000 entries), and at most 24 files: README, docs index, manifests (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, composer.json, Gemfile, pom.xml), Dockerfile/compose, `.env.example` (variable names only, never values), LICENSE, privacy/terms files. Limits: 60 KB per file, 400 KB in total.
- Deterministic analysis (`src/analyze.ts`, pure and unit tested): frameworks, databases, third-party services (payments, auth, analytics, monitoring, email, messaging, cloud, AI) from dependency and env-variable names; signals worded as "appears to" (user accounts, payments, personal data, health, children's data, AI providers) each with its evidence; repo license, licenses declared in manifests, a few known copyleft packages; maturity (README, tests, CI, docs, container config, license file, privacy policy and terms files, activity).
- AI synthesis (asynchronous job through `ctx.ai`): what it is, who it is for, features, likely business model, maturity, and "business and legal implications to review", each tied to scan evidence. Labelled as AI-generated and as suggestions for a professional.
- Re-scan, delete (cascades to scans), scan history (last 20) and "what changed since the last scan".
- Private repositories: paste a read-only personal access token.

## Tokens
- Encrypted at rest with AES-256-GCM using `FOUNDEROS_SECRET_KEY` (32 random bytes, base64: `openssl rand -base64 32`). The business id is bound as authenticated data.
- If the variable is missing or not 32 bytes, tokens are **not stored**: a token is used for that scan only and the UI says so.
- The browser only ever learns `hasToken: true/false`. Tokens are never logged, never put in error messages, never sent to any host except the fixed API host, and can be deleted at any time.
- Rotating the key makes stored tokens unreadable; users paste them again.

## Tables
`product_repos` (url, provider, owner, name, `token_enc`, last_scanned_at, status, last_error) and `product_scans` (repo_id, `result` jsonb, ai_summary, ai_job_id, ai_state, created_at). Every row carries `business_id`; scans cascade-delete with their repo.

## Publishes
- `facts()`: `{ linkedRepos, stack[], handlesUserAccounts, handlesPayments, appearsToCollectPersonalData, hasPrivacyPolicyInRepo, license, lastScanAt }` (signals from the latest scan of each repo, OR-ed).
- `describe()`: the latest AI one-line summary, or a deterministic profile (repo, stack, signals) when there is none. At most 600 characters. No AI is called here.
- `attention()`: personal data appears but no privacy policy file in the repo (review); payments appear but no terms file (review); public repo with no license (info); scan older than 90 days (info).
- `resolve()` / `search()` for linked repos; `LinkedItems` on the repo page.

## API (`/api/tools/product/...`)
`GET status`, `GET|POST repos`, `GET|DELETE repos/:id`, `POST repos/:id/scan`, `PUT|DELETE repos/:id/token`, `GET repos/:id/scans/:sid`, `GET repos/:id/compare[?from&to]`, `POST|GET repos/:id/scans/:sid/ai` (start / poll).

## Environment
| Variable | Purpose |
|---|---|
| `FOUNDEROS_SECRET_KEY` | 32-byte base64 key for encrypting saved access tokens. Optional; without it tokens are never saved. |

## Known limits
- GitHub and GitLab.com only (no self-hosted GitLab, Bitbucket, or other hosts). Unauthenticated GitHub calls are limited to 60 per hour per server IP; a scan uses roughly 10 to 35 calls, so private or busy installations should use tokens. A rate limit is reported in plain language.
- Detection works from names (dependencies, env variables, file paths); it cannot see runtime behaviour, so every signal is "appears to" and may be wrong either way. Licenses of dependencies are only visible when manifests declare them; run a license scanner for a real list.
- Monorepos: manifests up to three folders deep are read, up to 12 of them.
- Not built: scanning of branches other than the default, code-level analysis, secret scanning, webhooks or scheduled re-scans, comparing across repos.
- Tests: `npx vitest run modules/product`. The real GitHub check against `octocat/Hello-World` is a manual step, not part of the suite.
