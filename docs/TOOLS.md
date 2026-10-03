# Building a tool

A tool is a folder `modules/<id>/` that plugs into the FounderOS shell by exporting one `ToolDef` (`export const tool`). The reference
implementation is `modules/finance` (read it first: `src/index.tsx`, `src/ui/Calculators.tsx`, `test/finance.test.ts`). The contract is in
`modules/sdk/src/index.ts`.

## Layout
```
modules/<id>/
  package.json        name @founderos/<id>, main src/index.tsx (already created for every planned tool)
  src/index.tsx       export const tool: ToolDef  (status: "live" once it works)
  src/*.ts            domain logic: pure functions where possible (testable, usable in the browser)
  src/ui/*.tsx        "use client" components; they call /api/tools/<id>/...
  test/*.test.ts      vitest; run with `npx vitest run modules/<id>` from the repo root
  README.md           what it does, tables it owns, what it publishes (facts/describe/attention), known limits
```

## Rules (non-negotiable)
1. **Tenant isolation.** Every table is named `<id>_*`, has `business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE`, and every
   query filters by `ctx.businessId`. Never take a business id, user id or role from the request. Test it with `env.other`.
2. **Writes** call `requireWrite(ctx)` first (viewers are read-only).
3. **Validate** every request body with zod via `readJson`. Recompute anything derived on the server; never trust the browser's results.
4. **Tools never import each other.** Share through the context instead:
   - `facts(ctx)`: small JSON facts others may read (`ctx.facts()` returns everyone's).
   - `describe(ctx)`: <= 600 characters of plain English about what this tool knows right now. It becomes part of `ctx.context()` and
     feeds every other tool and the assistant. Return "" when there is nothing yet.
   - `attention(ctx)`: things the owner should look at (shown on the dashboard).
   - `resolve(ctx, id)` and `search(ctx, q, limit)`: let other tools link to and find your records. **Implement both** for every record type
     users would want to reference (return `{ title, href }` where href is a shell path such as `/app/t/crm/contacts/<id>`).
   - Use `<LinkedItems tool="<id>" id={record.id} canWrite={...} />` from `@founderos/sdk/ui` on record pages so users can link a record to
     anything in any tool.
5. **Use the whole business context.** Anything personalised (suggestions, rules, drafts) should start from `await ctx.context()`: the profile
   plus every other tool's summary. When using AI, put `bc.asText()` in the prompt so answers are grounded in the real business.
6. **AI** goes through `ctx.ai` (`available`, `start`, `poll`). It may be unavailable or slow (a private GPU): UIs must show progress,
   offer a non-AI path where reasonable, and never present AI output as fact. Do not call AI inside `facts/describe/attention/search`.
7. **Honesty.** No fake data. If a feature is not built, say so in the UI. Legal/tax/financial output carries a short "not advice" note where
   it matters. Never log secrets or document contents.
8. **Migrations** are inline in `tool.migrations` (`{ name: "0001_x", sql }`); append new ones, never edit applied ones. They run at server start.
9. **Tests** run against real Postgres via `makeTestEnv([tool, ...otherToolsYouNeed])` from `@founderos/sdk/testing`. Cover: the happy path,
   validation, tenant isolation, viewer read-only, and each published fact/describe/search/resolve. `FakeAi` scripts AI replies.
10. UI: Tailwind, dark slate theme matching the finance tool; accessible (labels, roles, keyboard); works on a phone width.

## Checklist before calling a tool done
- [ ] `status: "live"`, `Page` and `api` work end to end in the browser (`cd shell && npm run build && npm start`, needs local DB, see docs/DEVELOPMENT.md)
- [ ] `npx vitest run modules/<id>` green, `cd shell && npx tsc --noEmit` clean, `npm run lint` clean
- [ ] describe/facts/attention/resolve/search implemented and tested
- [ ] LinkedItems on record pages
- [ ] README.md in the tool folder; one line in docs/ROADMAP.md
