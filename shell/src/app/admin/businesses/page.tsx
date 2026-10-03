import Link from "next/link";
import { db } from "@/lib/db";
import { listBusinessesAdmin } from "@/lib/platform/admin";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export default async function AdminBusinesses({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireAdminPage();
  const { q } = await searchParams;
  const rows = await listBusinessesAdmin(db(), { search: typeof q === "string" ? q : undefined });
  return (
    <>
      <h1 className="text-2xl font-semibold">Businesses</h1>
      <form className="flex gap-2"><input name="q" defaultValue={q} placeholder="Search by name" aria-label="Search by name" className="rounded border border-slate-700 bg-slate-900 p-2 text-sm" /><button className="rounded bg-slate-800 px-3 text-sm">Search</button></form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-2">Name</th><th>Owner</th><th>Created</th><th>Members</th><th>Plan</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id} className="border-t border-slate-800">
                <td className="py-2"><Link className="text-sky-400 underline" href={`/admin/businesses/${b.id}`}>{b.name}</Link></td>
                <td className="font-mono text-xs">{b.ownerId ?? "-"}</td>
                <td>{b.createdAt.slice(0, 10)}</td><td>{b.members}</td><td>{b.plan ?? "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-4 text-sm text-slate-400">No businesses.</p>}
      </div>
    </>
  );
}
