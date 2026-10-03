# Finance tool

Calculators (runway, break-even, pricing, contractor vs employee, tax set-aside) plus **Monthly figures**, a lightweight ledger of totals the owner types in.

## Data source

There are no bank, Stripe or QuickBooks connections. Every monthly number is **entered by the user** and labelled "Entered by you; not connected to a bank or accounting system" in the UI, the API (`source`), `describe()` and attention text. Rows carry `source = 'manual'`.

## Monthly figures

Table `finance_months` (migration `0002_monthly_figures`): one row per business per month (`UNIQUE (business_id, month)`), month stored as the first of the month.
Columns: `revenue_cents`, `expenses_cents`, `cash_end_cents` (nullable, may be negative), `expense_breakdown` jsonb (nullable), `notes`, `source`, `created_by`, `updated_at`.

API (all under `/api/tools/finance/`, viewers read-only, scoped by business):

- `GET months` last 24 months, oldest first, plus computed `insights`
- `GET months/:month` one month (404 if none)
- `PUT months/:month` upsert. `:month` must be a real first-of-month date, not in the future. Amounts are integer cents; revenue and expenses `>= 0` and `< 1e12`; cash may be null or negative. `expenseBreakdown` keys are limited to `payroll, contractors, software, marketing, rent, insurance, taxes, supplies, other`, and the sum may exceed `expensesCents` by at most 100 cents (rounding).
- `DELETE months/:month`

## Insights (`src/insights.ts`, pure and tested)

Net per month; average revenue, expenses and burn over the latest month and the two calendar months before it (months not entered are not counted); month-over-month revenue change (only against the immediately preceding month); largest expense category (from the most recent month with a breakdown); runway = latest month's cash / average burn (latest month alone if the window has one month); break-even gap; freshness (latest month starting more than 45 days ago is stale). With fewer than 2 months everything trend-like says "not enough data". Nothing is projected beyond the data.

`src/ui/Chart.tsx` draws the SVG charts (no chart library).

## Facts, describe, attention

`facts()` keeps `calculatorsUsed`, `taxReserveConfigured`, `latestRunwayMonths` and adds:

```
snapshot: null | {
  month: "YYYY-MM-01", revenueCents, expensesCents, cashCents: number | null, netCents,
  runwayMonths: number | null, source: "entered", stale: boolean
}
```

`latestRunwayMonths` comes from the entered figures when they give a runway (or a profitable latest period, which gives `null`); otherwise from the latest saved runway calculation. In the profitable case `"runway"` is added to `calculatorsUsed` so the health check counts runway as checked.

Attention: stale figures (info, only when the business has customers); cash below zero or runway under 1 month (high); runway under 3 months (review). Based on entered figures only.

## Assistant action

`record_month` (`src/actions.ts`, risk medium): `{ month, revenueCents, expensesCents, cashCents? }`. It goes through `PUT months/:month`. The preview says whether it overwrites and shows old and new values. Omitted cash and the saved notes are kept; a saved expense breakdown is kept only if it still fits the new expenses, otherwise it is cleared (the preview says so).

## Not built

Bank or accounting imports, CSV import, categories beyond the fixed list, per-category trends, forecasting.

Tests: `npx vitest run modules/finance` from the repo root (needs the local `founderos_test` Postgres database).
