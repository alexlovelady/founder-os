# marketing: copy that sounds like the business

AI-assisted drafts (social posts, emails, landing copy, ad copy, review replies, blog outlines, content calendars, SEO ideas) written from the saved brand voice plus the whole business context (`ctx.context().asText()`).

## Honest limits
- **No posting, no analytics, no result claims.** The calendar stores planned dates only.
- AI runs on a slow private GPU, so every generation is async: `POST generate` returns `{ id }` (202), the UI polls `GET jobs/:id` (waiting/running/done/failed). Output is labelled "AI draft, review before use" and is never saved automatically.
- **Fabricated claims**: the system prompt forbids invented testimonials, statistics, prices, awards and guarantees (use `[●PLACEHOLDER]`). `src/guard.ts` additionally checks every finished draft on the server and returns `flags` for percentages, prices, large numbers, "N years/customers" statistics, ratings, quoted testimonials, guarantees and award/ranking claims that do not appear in the user's request, the brand profile or the business profile. It is a heuristic net, not proof; the UI shows a visible warning.

## Plan limits and the template path
- **AI usage**: every AI start (a draft, a brand-voice suggestion) calls `ctx.useQuota("ai_request")` once, immediately before `ctx.ai.start`. At the limit the API answers 402 with the plan message, nothing is queued, and the page shows it with a link to the billing page.
- **Write it for me (templates)**: `POST template` fills a deterministic fill-in-the-blank draft (`src/templates.ts`) for all eight kinds from a few plain answers (offer, audience, tone, key points, call to action, plus channel, review text, rating, weeks). Anything not given becomes a `[●PLACEHOLDER]`, no facts are invented, it needs no AI, is never metered and still works when AI is off or the monthly AI limit is used up. The response says `method: "template"` (AI drafts say `method: "ai"`) and the page labels each draft as AI or template. The fabricated-claim check still runs on the result. Tone defaults to the strongest brand-voice slider.

## Tables
`marketing_brand` (one row per business: voice, audience, offers, do/don't words, tone sliders), `marketing_items` (saved drafts with kind, channel, status draft/ready/published, scheduled_for, notes), `marketing_jobs` (maps our job id to the AI job id and keeps the user's request so the claim check can run on poll). All carry `business_id` with cascade delete.

## API (`/api/tools/marketing/...`)
`GET/PUT brand`, `POST brand/suggest`, `POST generate`, `GET jobs/:id`, `GET/POST items`, `GET/PUT/DELETE items/:id`, `GET calendar`.

## Publishes
- `facts`: `{ hasBrandVoice, itemCounts: { total, byKind, byStatus }, hasFollowUpEmail }`.
- `describe`: brand voice and audience excerpt plus saved draft counts.
- `attention`: one `info` item only when the business has customers (`operations.hasCustomers`) and no brand voice.
- `resolve` / `search`: title and body of saved items, href `/app/t/marketing/items/<id>`.

## Known limits
- Without AI you can still write and save copy by hand; there are no non-AI templates.
- `marketing_jobs` rows are not purged yet.
