import { db } from "@/lib/db";
import { listAuditAdmin } from "@/lib/platform/audit";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Q = { business?: string; user?: string; action?: string };

export default async function AdminAudit({ searchParams }: { searchParams: Promise<Q> }) {
  await requireAdminPage();
  const q = await searchParams;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : undefined);
  const business = str(q.business);
  const rows = await listAuditAdmin(db(), { businessId: business && UUID.test(business) ? business : undefined, userId: str(q.user), action: str(q.action), limit: 200 });
  return (
    <>
      <h1 className="text-2xl font-semibold">Audit log</h1>
      <form className="flex flex-wrap items-end gap-2 text-xs text-slate-400">
        <label>Business id<input name="business" defaultValue={q.business} className="mt-1 block rounded border border-slate-700 bg-slate-900 p-1 text-sm text-slate-100" /></label>
        <label>User id<input name="user" defaultValue={q.user} className="mt-1 block rounded border border-slate-700 bg-slate-900 p-1 text-sm text-slate-100" /></label>
        <label>Action starts with<input name="action" defaultValue={q.action} className="mt-1 block rounded border border-slate-700 bg-slate-900 p-1 text-sm text-slate-100" /></label>
        <button className="rounded bg-slate-800 px-3 py-1 text-sm text-slate-100">Filter</button>
      </form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-2">When</th><th>Action</th><th>User</th><th>Business</th><th>Resource</th><th>Meta</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="border-t border-slate-800 align-top">
                <td className="py-1 whitespace-nowrap text-slate-400">{a.createdAt.slice(0, 19).replace("T", " ")}</td>
                <td className="font-mono">{a.action}</td><td className="font-mono text-xs">{a.userId ?? "-"}</td>
                <td className="font-mono text-xs">{a.businessId?.slice(0, 8) ?? "-"}</td>
                <td className="text-xs">{a.resourceTool ? `${a.resourceTool}/${a.resourceId}` : "-"}</td>
                <td className="max-w-xs break-words font-mono text-xs text-slate-400">{JSON.stringify(a.meta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-4 text-sm text-slate-400">No events match.</p>}
      </div>
    </>
  );
}
