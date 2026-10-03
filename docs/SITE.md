# Public site

The public marketing site, free tools and trust pages live in the route group `shell/src/app/(site)/`. It has its own layout (header and footer, no app sidebar). The app stays under `/app` and sign-in at `/login`.

## Where things live
| What | Where |
|---|---|
| List of pages (single source for sitemap, metadata, links) | `shell/src/lib/site/pages.ts` |
| Base URL, contact email, legal "last updated" date, disclaimers | `shell/src/lib/site/config.ts` |
| Page copy | each `shell/src/app/(site)/**/page.tsx` |
| Header, footer, shared blocks | `shell/src/components/site/` |
| Calculators (re-exported from `@founderos/finance/src/calc`) | `shell/src/lib/site/calc.ts`, UI in `components/site/Calculators.tsx` |
| Startup checklist logic and the government links | `shell/src/lib/site/checklist.ts` |
| Business health check logic | `shell/src/lib/site/health-check.ts` |
| Prices and limits | read from `shell/src/config/plans.ts` (never copied) |
| `/sitemap.xml`, `/robots.txt` | `shell/src/app/sitemap.ts`, `robots.ts` |
| Tests | `shell/tests/site/site.test.ts` (`npx vitest run shell/tests/site`) |

To add a page: create `(site)/<path>/page.tsx` with `export const metadata = pageMetadata("/<path>")` and add an entry to `PAGES`. Tests fail if a listed page has no file, no metadata, or is missing from the sitemap.

## Environment
* `NEXT_PUBLIC_APP_URL`: public base URL for the sitemap, canonical links and OpenGraph (falls back to `https://$RAILWAY_PUBLIC_DOMAIN`, then `http://localhost:3000`).
* `NEXT_PUBLIC_CONTACT_EMAIL`: shown on `/contact` and `/security` when set, hidden when not. It is read at build time, so set it before building.

## Pages
`/`, `/features`, `/pricing`, `/legal-ai`, `/business-health`, `/security`, `/contact`, `/terms`, `/privacy`, `/ai-disclosure`, `/tools`, and tools `/tools/runway-calculator`, `/break-even-calculator`, `/pricing-calculator`, `/contractor-vs-employee`, `/tax-reserve`, `/startup-checklist`, `/business-health-check`.

## Free tools
All client-side; nothing is sent anywhere. Each ends with "Save this and track it in FounderOS: sign in" and a not-advice note. Not built: NDA generator and contract checker (they need the AI backend), plus the other SEO pages in spec section 80 (`/contract-review`, `/contractor-agreement`, `/sop-generator`).

## Copy rules
No certifications, customer counts, testimonials, ratings or results. Never present the product as a law firm, accountant or adviser. Describe only features that exist. A test greps the site files for a deny-list ("SOC 2", "HIPAA compliant", "PCI compliant", "bank-grade", "guarantee", "certified").

## Must be reviewed by a lawyer before launch
* `/terms`: entire page. Section 9 (liability, warranties, indemnity, governing law, disputes) is only a placeholder. Billing terms must be added before checkout goes live.
* `/privacy`: entire page. Placeholders for data-subject rights by jurisdiction and the retention schedule. Verify the list of processors (hosting provider, Stripe) and the statements "no advertising trackers" and "essential cookie only" against what actually ships, and add a cookie notice if any non-essential cookies or analytics are added.
* `/ai-disclosure`: entire page. Verify "private hardware, no third-party AI provider, no training on customer data" is still true at launch, and update before any paid tier uses another provider.
* `/security`: have an engineer confirm each "in place" item and the "not done yet" list are still accurate. Publish a security contact (`NEXT_PUBLIC_CONTACT_EMAIL`).
* `/legal-ai`, `/features`, the startup checklist and health-check wording: confirm the not-a-law-firm and not-advice language is adequate.

The three legal pages carry a visible DRAFT banner and a "last updated" date (`SITE.legalLastUpdated`). Remove the banner only after review.

## Government links (verified HTTP 200 on 2026-10-03)
IRS EIN, IRS business structures, estimated taxes, employment taxes, independent contractor page, state government websites; SBA business guide, choose a structure, register, licenses and permits, tax IDs, bank account, business plan; USCIS I-9. Re-check them periodically (`ALL_CHECKLIST_LINKS` in `checklist.ts`).
