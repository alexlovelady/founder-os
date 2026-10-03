# Business Health (`health`)

Answers "what am I forgetting?" across six areas: Legal, Compliance, Finance, Operations, Sales, Security. There is deliberately no numeric score.

## How it works
- `src/engine.ts` holds the rules and the pure engine. Each rule has profile conditions (does it matter to this business?) and a check on a fact published by another tool.
- Health owns no source data. It reads `ctx.business`, `ctx.facts()` and its own table.
- Statuses: `complete`, `attention`, `missing`, `not_applicable`, plus the derived `unknown` ("not tracked yet"). A missing tool, a missing key or a wrong-typed value is `unknown`, never complete, and the item says which tool to use.
- Manual confirmations (`health_confirmations`) let the user say an item is done outside the system (with a note) or not applicable. They override the derived status and can be undone.

## Facts it reads
vault: `hasFormationDocs, hasOperatingAgreement, hasPrivacyPolicy, hasContractorAgreement, hasInsurance, hasEin, documentCount, expired`; compliance: `itemCount, overdue, missing`; finance: `taxReserveConfigured, latestRunwayMonths, calculatorsUsed`; tasks: `overdue`; crm: `contactCount, staleCount, openOpportunities`; sops: `sopCount, hasCustomerOnboarding, hasIncidentPlan, hasBackupPlan`. Product Scan publishes nothing health uses yet.

## API (`/api/tools/health/...`)
`GET items?status=&category=` (items, `byCategory` counts, `totals`), `PUT confirmations/:ruleId` `{ status: complete|not_applicable, note }`, `DELETE confirmations/:ruleId`.

## Publishes
- `facts`: `{ counts: {<Category>: {complete, attention, missing, not_applicable, unknown}}, totals, attentionCount, missingCount, notTrackedCount }`
- `describe`: totals plus the top things possibly forgotten
- `attention`: items with status attention or missing that no other tool already raises itself (overdue compliance, overdue tasks, stale leads and expired documents are left to their own tools)
- `resolve` / `search`: rule ids (e.g. `legal-privacy-policy`), href `/app/t/health`

## Re-entrancy note
`ctx.facts()` calls every tool's `facts()`, and health's `facts()` needs `ctx.facts()`. A WeakSet guard makes the nested call return `{}` so assembly terminates and the outer call publishes real counts (covered by a test). A cleaner fix would be an SDK helper that exposes the other tools' facts without health in the loop.

## Deliberately not built
Per-business custom rules, thresholds beyond the 3-month runway rule of thumb, product/marketing/competitor checks (those tools publish no facts yet), notifications.
