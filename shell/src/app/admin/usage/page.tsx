import Link from "next/link";
import { costPercentOfRevenue } from "@/lib/admin/revenue";
import { loadRevenue } from "@/lib/admin/revenue-data";
import { costLast30Days, listUsageMetrics, parseUsageFilter, toolTokensByModel, usageReport } from "@/lib/admin/usage";
import { db } from "@/lib/db";
import { fetchLegalUsageLast30Days } from "@/lib/metering/legal-usage";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";
type SP = { from?: string; to?: string; metric?: string };
const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
const NOT_REPORTED = <span className="text-slate-500">not reported</span>;

export default async function AdminUsage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdminPage();
  const sp = await searchParams;
  const sql = db();
  const filter = parseUsageFilter(sp);
  const [r, metrics, c30, rev, toolTokens, legal] = await Promise.all([
    usageReport(sql, filter), listUsageMetrics(sql), costLast30Days(sql), loadRevenue(sql), toolTokensByModel(sql, filter), fetchLegalUsageLast30Days(),
  ]);
  const pct = c30.reported ? costPercentOfRevenue(c30.costUsd, rev.summary.mrr) : null;
  const qs = (view: string) => new URLSearchParams({ view, from: r.from, to: r.to, ...(r.metric ? { metric: r.metric } : {}) }).toString();
  const days = r.byDay.slice(-62);
  return (
    <>
      <h1 className="text-2xl font-semibold">Usage and AI cost</h1>
      <p className="text-sm text-slate-400">
        From usage_events: totals only, never content. Cost is an estimate that exists only where a tool passed estimated_cost_usd; tokens exist only where a tool recorded a token metric.
        usage_events has no tool column, so this page cannot say which tool an event came from.
      </p>
      <form className="flex flex-wrap items-end gap-3 text-xs text-slate-400">
        <label>From<input type="date" name="from" defaultValue={r.from} className="mt-1 block rounded border border-slate-700 bg-slate-900 p-1 text-sm text-slate-100" /></label>
        <label>To<input type="date" name="to" defaultValue={r.to} className="mt-1 block rounded border border-slate-700 bg-slate-900 p-1 text-sm text-slate-100" /></label>
        <label>Metric
          <select name="metric" defaultValue={r.metric ?? ""} className="mt-1 block rounded border border-slate-700 bg-slate-900 p-1 text-sm text-slate-100">
            <option value="">All metrics</option>{metrics.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <button className="rounded bg-slate-800 px-3 py-1 text-sm text-slate-100">Apply</button>
      </form>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {([
          ["Requests (non-token metrics)", r.requests.toLocaleString("en-US")],
          ["Tokens", r.tokens === null ? NOT_REPORTED : r.tokens.toLocaleString("en-US")],
          ["Estimated cost (local GPU: no per-token cost)", r.costReported ? usd(r.costUsd) : NOT_REPORTED],
          ["Cost as % of estimated MRR (30 days)", pct === null ? <span key="p" className="text-sm text-slate-500">needs both cost and revenue</span> : `${pct}%`],
        ] as [string, React.ReactNode][]).map(([label, v]) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><div className="text-2xl font-semibold">{v}</div><div className="text-xs text-slate-400">{label}</div></div>
        ))}
      </div>
      <p className="text-xs text-slate-500">Range {r.from} to {r.to}{r.metric ? `, metric ${r.metric}` : ""}. The percentage compares the last 30 days of reported cost with estimated MRR from plan list prices (see Revenue), not with invoices.</p>

      <section>
        <div className="mb-2 flex items-center gap-4"><h2 className="font-medium">By metric</h2><Link className="text-xs text-sky-400 underline" href={`/api/admin/usage/export?${qs("metric")}`}>Export CSV</Link></div>
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-1">Metric</th><th className="text-right">Events</th><th className="text-right">Quantity</th><th className="text-right">Est. cost</th><th className="text-right">Cost reported on</th><th className="text-right">Model recorded on</th></tr></thead>
          <tbody>
            {r.byMetric.map((m) => (
              <tr key={m.metric} className="border-t border-slate-800">
                <td className="py-1 font-mono">{m.metric}{m.isTokenMetric ? " (tokens)" : ""}</td><td className="text-right">{m.events}</td><td className="text-right">{m.quantity.toLocaleString("en-US")}</td>
                <td className="text-right">{m.eventsWithCost ? usd(m.costUsd) : NOT_REPORTED}</td>
                <td className="text-right">{m.eventsWithCost}/{m.events}</td><td className="text-right">{m.eventsWithModel}/{m.events}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {r.byMetric.length === 0 && <p className="py-2 text-sm text-slate-400">No usage in this range.</p>}
        {r.tokens === null && <p className="text-xs text-slate-500">No tool records token counts yet, so tokens show as not reported.</p>}
      </section>

      <section>
        <h2 className="mb-2 font-medium">AI tokens and LegalAI-side usage</h2>
        <p className="mb-2 text-xs text-slate-400">Local GPU: no per-token cost. Tokens are measured and cost is recorded as $0.00 unless a paid fallback model ran.</p>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="text-sm text-slate-300">Tool AI tokens (shell tools, selected range)</h3>
            <table className="w-full text-left text-sm">
              <thead className="text-slate-400"><tr><th className="py-1">Model</th><th className="text-right">Jobs</th><th className="text-right">Tokens</th></tr></thead>
              <tbody>
                {toolTokens.map((t) => <tr key={t.model} className="border-t border-slate-800"><td className="py-1 font-mono">{t.model}</td><td className="text-right">{t.events}</td><td className="text-right">{t.tokens.toLocaleString("en-US")}</td></tr>)}
              </tbody>
            </table>
            {toolTokens.length === 0 && <p className="py-2 text-sm text-slate-400">No tool AI tokens recorded in this range.</p>}
          </div>
          <div>
            <h3 className="text-sm text-slate-300">LegalAI pages, all users, last 30 days (not filtered by the range above)</h3>
            {legal ? (
              <table className="w-full text-left text-sm">
                <tbody>
                  <tr className="border-t border-slate-800"><td className="py-1">AI requests</td><td className="text-right">{legal.requests.toLocaleString("en-US")}</td></tr>
                  <tr className="border-t border-slate-800"><td className="py-1">Tokens (prompt + completion)</td><td className="text-right">{legal.tokens.toLocaleString("en-US")}</td></tr>
                  <tr className="border-t border-slate-800"><td className="py-1">Cost</td><td className="text-right">{usd(legal.costUsd)}</td></tr>
                </tbody>
              </table>
            ) : (
              <p className="py-2 text-sm text-slate-400">Not available: LegalAI did not answer (needs INTERNAL_PROVISION_TOKEN on both services and a current LegalAI).</p>
            )}
            <p className="text-xs text-slate-500">Includes work by users who have no FounderOS business. Requests started by shell tools are included here too because they run as LegalAI jobs.</p>
          </div>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-4"><h2 className="font-medium">Top businesses</h2><Link className="text-xs text-sky-400 underline" href={`/api/admin/usage/export?${qs("business")}`}>Export CSV</Link></div>
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-1">Business</th><th className="text-right">Events</th><th className="text-right">Quantity</th><th className="text-right">Est. cost</th></tr></thead>
          <tbody>
            {r.byBusiness.slice(0, 25).map((b) => (
              <tr key={b.businessId} className="border-t border-slate-800">
                <td className="py-1"><Link className="text-sky-400 underline" href={`/admin/businesses/${b.businessId}`}>{b.businessName}</Link></td>
                <td className="text-right">{b.events}</td><td className="text-right">{b.quantity.toLocaleString("en-US")}</td><td className="text-right">{b.costUsd > 0 ? usd(b.costUsd) : NOT_REPORTED}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <div className="mb-2 flex items-center gap-4"><h2 className="font-medium">By day</h2><Link className="text-xs text-sky-400 underline" href={`/api/admin/usage/export?${qs("day")}`}>Export CSV</Link></div>
        <table className="w-full max-w-xl text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-1">Day</th><th className="text-right">Events</th><th className="text-right">Quantity</th><th className="text-right">Est. cost</th></tr></thead>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.day} className="border-t border-slate-800"><td className="py-1">{d.day}</td><td className="text-right">{d.events}</td><td className="text-right">{d.quantity.toLocaleString("en-US")}</td><td className="text-right">{d.costUsd > 0 ? usd(d.costUsd) : "-"}</td></tr>
            ))}
          </tbody>
        </table>
        {r.byDay.length > days.length && <p className="text-xs text-slate-500">Showing the latest {days.length} days; the CSV has every day.</p>}
      </section>
    </>
  );
}
