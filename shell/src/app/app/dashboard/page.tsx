import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/server";
import { ENTITY_TYPES, OPERATION_QUESTIONS, STAGES, currentBusiness, setModuleLink } from "@/lib/business";
import { legalSummary, provisionLegal } from "@/lib/legal";
import { TOOLS } from "@/lib/tools/registry";
import { buildContext } from "@/lib/tools/context";

export const dynamic = "force-dynamic";

const label = (list: readonly { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? id;

export default async function Dashboard() {
  const session = await getSession();
  if (!session) redirect("/login");
  const business = await currentBusiness(session.user.id);
  if (!business) redirect("/app/onboarding");

  // If the legal workspace could not be created earlier (module was down), link it now.
  let workspaceId = (business.modules.legal as { workspaceId?: string } | undefined)?.workspaceId;
  if (!workspaceId) {
    const linked = await provisionLegal(session, business);
    if (linked) {
      workspaceId = linked.workspaceId;
      await setModuleLink(business.id, "legal", linked);
    }
  }
  const legal = workspaceId ? await legalSummary(session, workspaceId) : null;
  const ctx = await buildContext(session);
  const toolItems = ctx
    ? (await Promise.all(TOOLS.filter((t) => t.status === "live" && t.attention).map((t) => t.attention!(ctx).catch(() => [])))).flat()
    : [];
  const order = { high: 0, review: 1, info: 2 } as const;
  toolItems.sort((a, b) => order[a.severity] - order[b.severity]);
  const first = session.user.displayName?.split(" ")[0] || "";
  const ops = OPERATION_QUESTIONS.filter((q) => business.operations[q.key]);

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">{first ? `Welcome back, ${first}` : "Welcome back"}</h1>
        <p className="mt-1 text-slate-400">{business.name}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Needs attention</h2>
            {legal && <span className="text-xs text-slate-400">{legal.done} of {legal.total} legal basics done</span>}
          </div>
          {toolItems.length > 0 && (
            <ul className="mt-3 space-y-3">
              {toolItems.slice(0, 6).map((i) => (
                <li key={i.id} className="rounded-lg bg-slate-950 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium">{i.title}</div>
                    {i.href && <Link href={i.href} className="shrink-0 text-xs underline">Open</Link>}
                  </div>
                  {i.detail && <div className="mt-0.5 text-xs text-slate-400">{i.detail}</div>}
                </li>
              ))}
            </ul>
          )}
          {legal ? (
            legal.open.length > 0 ? (
              <ul className="mt-3 space-y-3">
                {legal.open.map((i) => (
                  <li key={i.title} className="rounded-lg bg-slate-950 p-3">
                    <div className="text-sm font-medium">{i.title}</div>
                    <div className="mt-0.5 text-xs text-slate-400">{i.why}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-slate-400">Your legal basics checklist is complete.</p>
            )
          ) : (
            <p className="mt-3 text-sm text-slate-400">LegalAI is not reachable right now, so legal items are not shown. Your business info is safe.</p>
          )}
          <Link href="/app/legal" className="mt-4 inline-block rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900">Open LegalAI</Link>
        </section>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Business profile</h2>
            <Link href="/app/settings" className="text-xs text-slate-400 underline">Edit</Link>
          </div>
          <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
            <dt className="text-slate-400">Structure</dt><dd>{label(ENTITY_TYPES, business.entityType)}</dd>
            <dt className="text-slate-400">Location</dt><dd>{[business.city, business.state].filter(Boolean).join(", ") || "Not set"}</dd>
            <dt className="text-slate-400">Stage</dt><dd>{label(STAGES, business.lifecycleStage)}</dd>
            <dt className="text-slate-400">Industry</dt><dd>{business.industry || "Not set"}</dd>
            <dt className="text-slate-400">Team</dt><dd>{business.employeeCount ?? "Not set"}</dd>
          </dl>
          {ops.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {ops.map((q) => <span key={q.key} className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{q.label.replace(/^We /, "")}</span>)}
            </div>
          )}
        </section>
      </div>

      <section>
        <h2 className="mb-3 font-medium">Your tools</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TOOLS.map((m) => (
            <div key={m.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">{m.name}</h3>
                <span className={`rounded px-1.5 py-0.5 text-[10px] ${m.status === "live" ? "bg-emerald-900 text-emerald-200" : "bg-slate-800 text-slate-400"}`}>{m.status === "live" ? "Live" : "Soon"}</span>
              </div>
              <p className="mt-2 text-xs text-slate-400">{m.description}</p>
              {m.status === "live" && <Link href={`/app/t/${m.id}`} className="mt-3 inline-block text-xs underline">Open</Link>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
