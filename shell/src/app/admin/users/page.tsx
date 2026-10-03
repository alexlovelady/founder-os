import SuspendButton from "@/components/admin/SuspendButton";
import { listUsers } from "@/lib/admin/suspensions";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export default async function AdminUsers({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const session = await requireAdminPage();
  const { q } = await searchParams;
  const rows = await listUsers(db(), { search: typeof q === "string" ? q : undefined });
  return (
    <>
      <h1 className="text-2xl font-semibold">Users</h1>
      <p className="text-sm text-slate-400">
        Users the shell knows: anyone with a business membership. Email and name come from team profiles when the person has opened the team page.
        Accounts live in LegalAI. Suspension blocks use of the shell; every suspend and lift needs a reason and is audited. You cannot suspend yourself, and
        the shell cannot tell whether another user is an admin, so check before suspending a colleague.
      </p>
      <form className="flex gap-2"><input name="q" defaultValue={q} placeholder="Search id, email or name" aria-label="Search users" className="rounded border border-slate-700 bg-slate-900 p-2 text-sm" /><button className="rounded bg-slate-800 px-3 text-sm">Search</button></form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-2">User</th><th>Email</th><th>Businesses</th><th>Last seen</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.userId} className="border-t border-slate-800 align-top">
                <td className="py-2"><div>{u.displayName ?? "-"}</div><div className="font-mono text-xs text-slate-500">{u.userId}</div></td>
                <td>{u.email ?? "-"}</td><td>{u.businesses}</td><td>{u.lastSeenAt ? u.lastSeenAt.slice(0, 16).replace("T", " ") : "-"}</td>
                <td>{u.suspended ? <span className="text-amber-400">Suspended{u.suspendedReason ? `: ${u.suspendedReason}` : ""}</span> : <span className="text-emerald-400">Active</span>}</td>
                <td><SuspendButton userId={u.userId} suspended={u.suspended} self={u.userId === session.user.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="py-4 text-sm text-slate-400">No users.</p>}
      </div>
    </>
  );
}
