# Competitor Research (`competitors`)

Add competitors (name and website). FounderOS reads their public pages politely and safely, then an AI job analyses the fetched text against your business context. Every claim keeps the URL it came from and when it was fetched; gaps are never filled from memory.

## What is live
- Add, edit notes, delete competitors; add up to 5 extra pages on the same site.
- **SSRF-safe fetcher** (`src/safe-fetch.ts`, written inside this tool; the Python reference is `modules/legal/api/legalai/corpus/safe_fetch.py`): https only (http is upgraded, never fetched in the clear), default port only, no credentials; DNS is resolved once, every answer must be public (loopback, private, link-local and cloud metadata, CGNAT, multicast, reserved, documentation, IPv4-mapped / NAT64 / 6to4 / teredo IPv6 are refused), and the connection goes to that exact checked address, so DNS cannot change between check and connect. All of it repeats on every redirect hop (max 3). Response cap 1.5 MB (also for decompressed bodies), 15 s total, only `text/html` and `text/plain`, user agent `FounderOS-Research/1.0`.
- **robots.txt** is fetched per origin (also for the host a redirect leads to). Disallowed pages are skipped and listed to the user. 4xx means no rules, a failing robots.txt (5xx or unreadable) means "do not crawl".
- **Pages**: the home page, pages the user added, and same-site links that look like pricing, product/features or about pages, at most 6 per competitor. HTML is reduced to readable text (scripts, styles, nav, footer, aside removed; entities decoded) with a small helper in `src/html.ts`, no dependency.
- **Rate limiting** per business: every outbound request (robots.txt included) is logged; 120 per hour; plus 30 s between two runs on the same competitor.
- **Change tracking**: each page keeps a content hash and the previous one; re-running shows which pages changed since the last fetch.
- **Analysis** (async AI job per competitor, grounded in fetched text, `ctx.context()` and `ctx.facts()` including the Product Scan signals): positioning, target customer, offerings, pricing, strengths, weaknesses, comparison with your business. The model's JSON is checked in code: a source URL must be a page we really fetched and `fetched_at` comes from our record; a quote is "verified" only if it literally appears on that page; **pricing claims without a verified quote are discarded** and shown as discarded. If the answer cannot be parsed it is shown as unsourced text, not as claims.
- **Cross-competitor report** (async): comparison matrix and "where you could stand out", built only from stored sourced claims; the stand-out ideas are labelled AI opinion.
- **Discovery**: with `SEARCH_API_KEY` the Brave Search API is used (fixed host `api.search.brave.com`; results are shown as web results to check). Without it the AI may suggest names from general knowledge, always labelled "Unverified suggestion, check the website", with no URLs.

## Tables
`competitors_items`, `competitors_pages` (url, excerpt capped at 12,000 characters, content_hash, fetched_at, prev_hash, changed), `competitors_analyses` (result jsonb with sources, claims and rejected claims; ai_summary; ai_job_id), `competitors_reports`, `competitors_discoveries`, `competitors_fetch_log` (request counts only, no URLs; rows older than a day are pruned). All carry `business_id`; everything cascades from the business and from the competitor.

## Publishes
- `facts()`: `{ competitorCount, lastResearchAt, competitors[] }`.
- `describe()`: how many competitors are tracked, which, how many were read and analysed. Deterministic, no AI.
- `attention()`: no competitors researched yet while the business has customers (info); analyses older than 90 days (info); a competitor page changed since the last check (info).
- `resolve()` / `search()` (name, url, notes); `LinkedItems` on the competitor page.

## API (`/api/tools/competitors/...`)
`GET status`, `GET|POST competitors`, `GET|PATCH|DELETE competitors/:id`, `POST competitors/:id/pages`, `DELETE competitors/:id/pages/:pid`, `POST competitors/:id/fetch`, `POST competitors/:id/analyze`, `GET competitors/:id/analyses/:aid` (poll), `POST report`, `GET reports`, `GET reports/:rid` (poll), `POST discover`, `GET discover/:did` (poll).

## Environment
| Variable | Purpose |
|---|---|
| `SEARCH_API_KEY` | Brave Search API key for competitor discovery. Optional. Never returned to the browser or logged. |
| `FOUNDEROS_SECRET_KEY` | Not used by this tool (it is used by Product Scan). |

## Known limits
- Reads static HTML only: pages that render their content with JavaScript, or sit behind logins and bot walls, give little or no text and say so.
- Pricing is reported only when quoted on a page we read; many sites hide prices.
- No Crawl-delay handling beyond the rate limits; no sitemap crawling; no screenshots; no scheduled re-runs (the owner re-runs; attention flags stale analyses).
- AI output is opinion. The tool shows its sources so a person can check them.
- Tests: `npx vitest run modules/competitors` (network is injected and scripted; nothing leaves the process).
