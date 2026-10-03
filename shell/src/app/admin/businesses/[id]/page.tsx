import { notFound } from "next/navigation";
import FlagOverrideForm from "@/components/platform/FlagOverrideForm";
import { db } from "@/lib/db";
import { adminBusinessDetail } from "@/lib/platform/admin";
import { recordAudit } from "@/lib/platform/audit";
import { flagsFor, listFlags } from "@/lib/platform/flags";
import { requireAdminPage } from "@/lib/platform/http";
import { TOOLS } from "@/lib/tools/registry";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminBusiness({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdminPage();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sql = db();
  const d = await adminBusinessDetail(sql, id, TOOLS.map((t) => t.id));
  if (!d) notFound();
  await recordAudit(sql, { businessId: id, userId: session.user.id, action: "admin.business.view", resource: { tool: "platform", id } });
  const [flags, effective] = await Promise.all([listFlags(sql), flagsFor(sql, id)]);
  return (
    <>
      <h1 className="text-2xl font-semibold">{String(d.profile.name)}</h1>
      <p className="text-sm text-slate-400">Read-only view. Document contents and tool rows are never shown here.</p>
      <section className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-2 font-medium">Profile</h2>
          <dl className="grid grid-cols-[9rem_1fr] gap-y-1 text-sm">
            {Object.entries(d.profile).filter(([k]) => k !== "name").map(([k, v]) => (
              <div key={k} className="contents"><dt className="text-slate-400">{k}</dt><dd>{v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? "-")}</dd></div>
            ))}
            <dt className="text-slate-400">plan</dt><dd>{d.plan ?? "-"}</dd>
          </dl>
        </div>
        <div>
          <h2 className="mb-2 font-medium">Members</h2>
          <ul className="space-y-1 text-sm">{d.members.map((m) => <li key={m.userId}><span className="font-mono text-xs">{m.userId}</span> <span className="text-slate-400">{m.role}</span></li>)}</ul>
        </div>
      </section>
      <section>
        <h2 className="mb-2 font-medium">Row counts</h2>
        <table className="w-full max-w-lg text-left text-sm"><tbody>{d.counts.map((c) => <tr key={c.table} className="border-t border-slate-800"><td className="py-1 font-mono">{c.table}</td><td className="text-right">{c.rows}</td></tr>)}</tbody></table>
      </section>
      <section className="space-y-2">
        <h2 className="font-medium">Feature flags for this business</h2>
        <ul className="text-sm">{Object.entries(effective).map(([k, v]) => <li key={k}><span className="font-mono">{k}</span>: {v ? "on" : "off"}</li>)}</ul>
        <FlagOverrideForm businessId={id} keys={flags.map((f) => f.key)} />
      </section>
      <section>
        <h2 className="mb-2 font-medium">Recent audit</h2>
        <ul className="space-y-1 text-sm">{d.audit.map((a) => <li key={a.id}><span className="text-slate-400">{a.createdAt.slice(0, 19).replace("T", " ")}</span> <span className="font-mono">{a.action}</span> <span className="text-xs text-slate-500">{a.userId}</span></li>)}</ul>
        {d.audit.length === 0 && <p className="text-sm text-slate-400">Nothing recorded.</p>}
      </section>
    </>
  );
}
