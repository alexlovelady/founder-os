import { db } from "@/lib/db";
import { adminOverview } from "@/lib/platform/admin";
import { requireAdminPage } from "@/lib/platform/http";
import { TOOLS } from "@/lib/tools/registry";

export const dynamic = "force-dynamic";

export default async function AdminOverview() {
  await requireAdminPage();
  const o = await adminOverview(db(), TOOLS.map((t) => t.id));
  const stats: [string, number][] = [
    ["Users with a business", o.users], ["Businesses", o.businesses], ["Audit events (7 days)", o.auditLast7Days],
    ["Product events (7 days)", o.analyticsLast7Days], ["New feedback", o.newFeedback],
  ];
  return (
    <>
      <h1 className="text-2xl font-semibold">Overview</h1>
      <p className="text-sm text-slate-400">Users are counted from business memberships; accounts themselves live in LegalAI.</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {stats.map(([label, n]) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="text-2xl font-semibold">{n}</div>
            <div className="text-xs text-slate-400">{label}</div>
          </div>
        ))}
      </div>
      <section>
        <h2 className="mb-2 font-medium">Rows per tool table</h2>
        <table className="w-full max-w-lg text-left text-sm">
          <tbody>
            {o.toolRows.map((t) => <tr key={t.table} className="border-t border-slate-800"><td className="py-1 font-mono">{t.table}</td><td className="text-right">{t.rows}</td></tr>)}
          </tbody>
        </table>
      </section>
    </>
  );
}
