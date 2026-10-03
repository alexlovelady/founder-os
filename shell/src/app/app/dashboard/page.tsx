import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/server";
import { ENTITY_TYPES, OPERATION_QUESTIONS, STAGES, currentBusiness, setModuleLink } from "@/lib/business";
import { legalSummary, provisionLegal } from "@/lib/legal";
import { getPlan } from "@/config/plans";
import { TOOLS } from "@/lib/tools/registry";
import { buildContext } from "@/lib/tools/context";
import {
  describeDue, docsView, financeView, formatMoney, formatMonth, gettingStarted, HEALTH_COOKIE, healthSummary, selectUpcoming, sortBySeverity, tasksView, todayKey,
  type AttentionLike,
} from "@/lib/dashboard/logic";
import AskBox from "@/components/dashboard/AskBox";
import AttentionList from "@/components/dashboard/AttentionList";
import Greeting from "@/components/dashboard/Greeting";

export const dynamic = "force-dynamic";

const label = (list: readonly { id: string; label: string }[], id: string) => list.find((x) => x.id === id)?.label ?? id;
const card = "rounded-xl border border-slate-800 bg-slate-900 p-5";
const btn = "inline-block rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900";
const btnGhost = "inline-block rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800";
const SEVERE_LINK = "text-xs underline";

type FactMap = Record<string, Record<string, unknown>>;

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
  const facts: FactMap = ctx ? ((await ctx.facts().catch(() => ({}))) as FactMap) : {};
  const attentionRaw: AttentionLike[] = ctx
    ? (await Promise.all(TOOLS.filter((t) => t.status === "live" && t.attention).map((t) => t.attention!(ctx).catch(() => [])))).flat()
    : [];
  const items = sortBySeverity(attentionRaw);
  const today = todayKey(new Date());
  const upcoming = selectUpcoming(items, today, 30);
  const jar = await cookies();
  const progress = gettingStarted(facts, {
    healthVisited: jar.get(HEALTH_COOKIE)?.value === "1",
    askedBefore: Number(facts.founderai?.conversationCount ?? 0) > 0,
  });
  const health = healthSummary(facts);
  const fin = financeView(facts);
  const docs = docsView(facts);
  const tasks = tasksView(facts);
  const competitors = Number(facts.competitors?.competitorCount ?? 0);
  const contacts = Number(facts.crm?.contactCount ?? 0);
  const first = session.user.displayName?.split(" ")[0] || "";
  const ops = OPERATION_QUESTIONS.filter((q) => business.operations[q.key]);
  const planName = ctx ? getPlan(ctx.plan.id).name : null;
  const canWrite = ctx?.canWrite ?? false;
  const dueByItem = new Map(upcoming.map((u) => [u.item.id, describeDue(u.daysUntil)]));

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:space-y-8 sm:p-8">
      <div>
        <Greeting name={first} />
        <p className="mt-1 text-slate-400">
          {business.name} <span className="text-slate-600">·</span> your role: {business.role}
          {planName && <> <span className="text-slate-600">·</span> <Link href="/app/billing" className="underline">{planName} plan</Link></>}
        </p>
        <p className="mt-0.5 text-xs text-slate-500">Several businesses? Switch between them from the sidebar.</p>
      </div>

      {!progress.complete && (
        <section className="rounded-xl border border-indigo-900 bg-indigo-950/40 p-5" aria-labelledby="gs-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="gs-title" className="font-medium">Getting started: {progress.doneCount} of {progress.total} done</h2>
            <Link href="/app/welcome" className={btn}>Getting started</Link>
          </div>
          <ul className="mt-3 grid gap-1.5 text-sm sm:grid-cols-2">
            {progress.steps.map((s) => (
              <li key={s.key} className={s.done ? "text-slate-500 line-through" : "text-slate-200"}>
                <span aria-hidden>{s.done ? "✓ " : "○ "}</span>
                <span className="sr-only">{s.done ? "Done: " : "To do: "}</span>
                {s.done ? s.title : <Link href={s.href} className="underline">{s.title}</Link>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <AskBox />{/* viewers may ask: the assistant only reads data they can already see */}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className={`${card} lg:col-span-2`} aria-labelledby="att-title">
          <div className="flex items-center justify-between">
            <h2 id="att-title" className="font-medium">Needs attention</h2>
            {legal && <span className="text-xs text-slate-400">{legal.done} of {legal.total} legal basics done</span>}
          </div>
          {items.length > 0 ? (
            <AttentionList items={items.map((i) => ({ id: i.id, title: i.title, detail: i.detail, severity: i.severity, href: i.href, dueLabel: dueByItem.get(i.id) }))} />
          ) : (
            <p className="mt-3 text-sm text-slate-400">Nothing from your tools needs attention right now. As you add documents, tasks and checklist items, anything overdue or missing shows up here.</p>
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
          <Link href="/app/legal" className={`mt-4 ${btn}`}>Open LegalAI</Link>
        </section>

        <section className={card} aria-labelledby="up-title">
          <h2 id="up-title" className="font-medium">Upcoming</h2>
          <p className="text-xs text-slate-500">Dated items from your tools, next 30 days.</p>
          {upcoming.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {upcoming.slice(0, 8).map((u) => (
                <li key={u.item.id} className="rounded-lg bg-slate-950 p-2.5 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">{u.item.title}</span>
                    {u.item.href && <Link href={u.item.href} className={`shrink-0 ${SEVERE_LINK}`}>Open</Link>}
                  </div>
                  <div className={`text-xs ${u.overdue ? "text-red-300" : "text-slate-400"}`}>{describeDue(u.daysUntil)} · {u.item.dueDate?.slice(0, 10)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-400">No dated items in the next 30 days.</p>
          )}
          <div className="mt-3 border-t border-slate-800 pt-3 text-sm">
            {tasks.empty ? (
              <>
                <p className="text-slate-400">No tasks yet.</p>
                {canWrite && <Link href="/app/t/tasks" className={`mt-2 ${btnGhost}`}>Create your first task</Link>}
              </>
            ) : (
              <p className="text-slate-300">
                Tasks: {tasks.open} open, {tasks.dueThisWeek} due in 7 days{tasks.overdue > 0 && <>, <span className="text-red-300">{tasks.overdue} overdue</span></>}.{" "}
                <Link href="/app/t/tasks" className="underline">Open tasks</Link>
              </p>
            )}
          </div>
        </section>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className={card} aria-labelledby="bh-title">
          <div className="flex items-center justify-between">
            <h2 id="bh-title" className="font-medium">Business health</h2>
            <Link href="/app/t/health" className="text-xs text-slate-400 underline">Open</Link>
          </div>
          {health ? (
            <>
              <p className="mt-1 text-xs text-slate-400">{health.complete} complete, {health.attention} need attention, {health.missing} missing{health.unknown > 0 ? `, ${health.unknown} not tracked yet` : ""}.</p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {health.rows.map((r) => (
                  <li key={r.category} className="flex items-center justify-between gap-2">
                    <span>{r.category}</span>
                    <span className="text-xs text-slate-400">
                      {r.complete}/{r.total} done{r.attention > 0 && <span className="text-amber-300">, {r.attention} attention</span>}{r.missing > 0 && <span>, {r.missing} missing</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-3 text-sm text-slate-400">Not tracked yet. Open Business health to see which checks apply to you.</p>
          )}
        </section>

        <section className={card} aria-labelledby="fin-title">
          <div className="flex items-center justify-between">
            <h2 id="fin-title" className="font-medium">Financial snapshot</h2>
            <Link href="/app/t/finance" className="text-xs text-slate-400 underline">Open</Link>
          </div>
          {fin.snapshot && (
            <>
              <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
                <dt className="text-slate-400">Cash</dt><dd>{formatMoney(fin.snapshot.cash)}</dd>
                <dt className="text-slate-400">Monthly revenue</dt><dd>{formatMoney(fin.snapshot.monthlyRevenue)}</dd>
                <dt className="text-slate-400">Monthly expenses</dt><dd>{formatMoney(fin.snapshot.monthlyExpenses)}</dd>
                {fin.snapshot.month && <><dt className="text-slate-400">Month</dt><dd>{formatMonth(fin.snapshot.month)}</dd></>}
              </dl>
              <p className="mt-2 text-xs text-slate-500">Source: {fin.snapshot.source ? `${fin.snapshot.source}, entered by you in Finance tools` : "entered by you in Finance tools"}</p>
            </>
          )}
          {fin.empty ? (
            <>
              <p className="mt-3 text-sm text-slate-400">No numbers yet. FounderOS does not guess: add your cash and monthly figures to see runway.</p>
              <Link href="/app/t/finance" className={`mt-3 ${btn}`}>Add your numbers</Link>
            </>
          ) : (
            <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1.5 border-t border-slate-800 pt-3 text-sm">
              <dt className="text-slate-400">Runway</dt><dd>{fin.runway}</dd>
              <dt className="text-slate-400">Tax reserve</dt><dd>{fin.taxReserve === "set up" ? "Set up" : "Not set up"}</dd>
            </dl>
          )}
          {!fin.empty && !fin.snapshot && <Link href="/app/t/finance" className={`mt-3 ${btnGhost}`}>Add your numbers</Link>}
          {!fin.empty && <p className="mt-2 text-xs text-slate-500">Source: calculators you ran in Finance tools.</p>}
        </section>

        <section className={card} aria-labelledby="doc-title">
          <div className="flex items-center justify-between">
            <h2 id="doc-title" className="font-medium">Documents</h2>
            <Link href="/app/t/vault" className="text-xs text-slate-400 underline">Open</Link>
          </div>
          {docs.empty ? (
            <>
              <p className="mt-3 text-sm text-slate-400">No documents yet. Upload your main customer agreement to start your vault.</p>
              {canWrite && <Link href="/app/t/vault" className={`mt-3 ${btn}`}>Upload a document</Link>}
            </>
          ) : (
            <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-slate-400">Documents</dt><dd>{docs.count}</dd>
              <dt className="text-slate-400">Expiring soon</dt><dd className={docs.expiringSoon > 0 ? "text-amber-300" : ""}>{docs.expiringSoon}</dd>
              <dt className="text-slate-400">Expired</dt><dd className={docs.expired > 0 ? "text-red-300" : ""}>{docs.expired}</dd>
              <dt className="text-slate-400">Searchable</dt><dd>{docs.withText} with text read</dd>
            </dl>
          )}
          <p className="mt-2 text-xs text-slate-500">Source: Vault.</p>
        </section>
      </div>

      {(competitors === 0 || contacts === 0) && (
        <section className={card} aria-labelledby="next-title">
          <h2 id="next-title" className="font-medium">Fill in the gaps</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {contacts === 0 && (
              <div className="rounded-lg bg-slate-950 p-3 text-sm">
                <p className="text-slate-300">No contacts yet. Keep customers and leads in one place.</p>
                {canWrite && <Link href="/app/t/crm" className={`mt-2 ${btnGhost}`}>Add a contact</Link>}
              </div>
            )}
            {competitors === 0 && (
              <div className="rounded-lg bg-slate-950 p-3 text-sm">
                <p className="text-slate-300">No competitors tracked yet. Add one to get a comparison.</p>
                {canWrite && <Link href="/app/t/competitors" className={`mt-2 ${btnGhost}`}>Add a competitor</Link>}
              </div>
            )}
          </div>
        </section>
      )}

      <section className={card}>
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
