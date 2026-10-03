import { notFound } from "next/navigation";
import PlanOverrideForm from "@/components/admin/PlanOverrideForm";
import FlagOverrideForm from "@/components/platform/FlagOverrideForm";
import { PLANS } from "@/config/plans";
import { resolvePlan } from "@/lib/billing";
import { METRICS } from "@/lib/billing/metrics";
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
  const [flags, effective, resolved] = await Promise.all([listFlags(sql), flagsFor(sql, id), resolvePlan(sql, id)]);
  const ov = resolved.override;
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
        <h2 className="font-medium">Plan and override</h2>
        <p className="text-sm">
          Effective plan: <strong>{resolved.plan.name}</strong>{" "}
          <span className="text-slate-400">
            (from {resolved.source === "override" ? "an admin override" : resolved.source === "subscription" ? `the subscription, status ${resolved.status}` : "the default free plan"}
            {resolved.graceExpired ? "; payment failed and the grace period has ended" : ""})
          </span>
        </p>
        {ov && <p className="text-xs text-slate-400">Override set by <span className="font-mono">{ov.set_by}</span> on {ov.created_at.toISOString().slice(0, 10)}: {ov.reason || "no reason recorded"}</p>}
        <p className="text-xs text-slate-500">An override wins over any Stripe subscription until cleared, and is not counted in estimated revenue. Every change is audited.</p>
        <PlanOverrideForm
          businessId={id}
          plans={PLANS.map((p) => ({ id: p.id, name: p.name }))}
          limits={METRICS.map((m) => ({
            key: m.key, label: m.label,
            byPlan: Object.fromEntries(PLANS.map((p) => [p.id, p.limits[m.key] ?? null])),
            current: ov?.limits && m.key in ov.limits ? (ov.limits[m.key] === null ? "unlimited" : String(ov.limits[m.key])) : "",
          }))}
          current={ov ? { plan: ov.plan, reason: ov.reason } : null}
        />
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
