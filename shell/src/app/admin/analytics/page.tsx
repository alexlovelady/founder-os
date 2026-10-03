import { db } from "@/lib/db";
import { eventCountsByDay } from "@/lib/platform/events";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export default async function AdminAnalytics() {
  await requireAdminPage();
  const rows = await eventCountsByDay(db(), 30);
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.name, (totals.get(r.name) ?? 0) + r.count);
  return (
    <>
      <h1 className="text-2xl font-semibold">Product analytics (last 30 days)</h1>
      <p className="text-sm text-slate-400">First-party events only; businesses that opted out are not counted.</p>
      <section>
        <h2 className="mb-2 font-medium">By event</h2>
        <table className="w-full max-w-md text-left text-sm"><tbody>
          {[...totals].sort((a, b) => b[1] - a[1]).map(([n, c]) => <tr key={n} className="border-t border-slate-800"><td className="py-1 font-mono">{n}</td><td className="text-right">{c}</td></tr>)}
        </tbody></table>
        {rows.length === 0 && <p className="text-sm text-slate-400">No events yet.</p>}
      </section>
      <section>
        <h2 className="mb-2 font-medium">By day</h2>
        <table className="w-full max-w-md text-left text-sm"><thead className="text-slate-400"><tr><th>Day</th><th>Event</th><th className="text-right">Count</th></tr></thead><tbody>
          {rows.map((r) => <tr key={`${r.day}-${r.name}`} className="border-t border-slate-800"><td className="py-1">{r.day}</td><td className="font-mono">{r.name}</td><td className="text-right">{r.count}</td></tr>)}
        </tbody></table>
      </section>
    </>
  );
}
