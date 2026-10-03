import { PLANS } from "@/config/plans";
import { loadRevenue } from "@/lib/admin/revenue-data";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export default async function AdminRevenue() {
  await requireAdminPage();
  const r = await loadRevenue(db());
  const s = r.summary;
  const stats: [string, string][] = [
    ["Estimated MRR", usd(s.mrr)], ["Paying subscribers", String(s.payingSubscribers)], ["ARPU (estimated)", s.arpu === null ? "-" : usd(s.arpu)],
    ["Trials", String(s.trials)], ["Past due", String(s.pastDue)], ["Canceled, last 30 days", String(s.canceledLast30)], ["Canceled, last 90 days", String(s.canceledLast90)],
    ["Trial-to-paid (approx.)", r.conversion.rate === null ? "no data" : `${Math.round(r.conversion.rate * 100)}%`],
  ];
  return (
    <>
      <h1 className="text-2xl font-semibold">Revenue</h1>
      <p className="rounded border border-amber-700/50 bg-amber-950/40 p-3 text-sm text-amber-200">
        Estimated, not accounting data. MRR is computed from the subscriptions mirror and the plan list prices in config/plans.ts (active, trialing and past-due paid plans).
        It excludes free plans and admin plan overrides, and ignores discounts, coupons, tax, proration and failed charges. Stripe is the source of truth for what was actually billed.
      </p>
      {!r.billingEnabled && (
        <p className="rounded border border-slate-700 bg-slate-900 p-3 text-sm text-slate-300">Billing is not enabled; every business is on the top plan. Numbers below reflect only whatever subscription rows exist.</p>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map(([label, v]) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="text-2xl font-semibold">{v}</div><div className="text-xs text-slate-400">{label}</div></div>
        ))}
      </div>
      <section>
        <h2 className="mb-2 font-medium">Subscribers per plan</h2>
        <table className="w-full max-w-2xl text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-1">Plan</th><th className="text-right">List price</th><th className="text-right">Subscribers</th><th className="text-right">Trialing</th><th className="text-right">Past due</th><th className="text-right">Est. MRR</th></tr></thead>
          <tbody>
            {s.perPlan.map((p) => (
              <tr key={p.plan} className="border-t border-slate-800"><td className="py-1">{p.name}</td><td className="text-right">{usd(p.priceMonthlyUsd)}</td><td className="text-right">{p.subscribers}</td><td className="text-right">{p.trialing}</td><td className="text-right">{p.pastDue}</td><td className="text-right">{usd(p.mrr)}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1 text-xs text-slate-500">Paid plans configured: {PLANS.filter((p) => p.priceMonthlyUsd > 0).map((p) => p.name).join(", ")}. Paid subscriptions not counted because an admin override applies: {s.excludedByOverride}.</p>
      </section>
      <section>
        <h2 className="mb-2 font-medium">New and canceled, last 6 months</h2>
        <table className="w-full max-w-md text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-1">Month</th><th className="text-right">New</th><th className="text-right">Canceled</th></tr></thead>
          <tbody>{r.series.map((m) => <tr key={m.month} className="border-t border-slate-800"><td className="py-1">{m.month}</td><td className="text-right">{m.newSubscriptions}</td><td className="text-right">{m.canceled}</td></tr>)}</tbody>
        </table>
        <p className="mt-1 text-xs text-slate-500">
          New = product analytics event subscription_started{r.startedEvents === 0 ? " (none recorded yet, so this column is empty)" : ""}; businesses that opted out of analytics are not counted.
          Canceled = subscriptions now in status canceled, bucketed by their last update time (the subscriptions table has no created_at).
        </p>
      </section>
      <section>
        <h2 className="mb-1 font-medium">Trial-to-paid conversion</h2>
        <p className="text-sm text-slate-300">
          {r.conversion.rate === null
            ? "No subscription_started events yet, so there is nothing to compute."
            : `${r.conversion.nowPaying} of ${r.conversion.started} businesses that started a subscription are now on an active paid plan.`}
        </p>
        <p className="text-xs text-slate-500">Approximation from analytics events; it does not separate trial starts from direct purchases.</p>
      </section>
    </>
  );
}
