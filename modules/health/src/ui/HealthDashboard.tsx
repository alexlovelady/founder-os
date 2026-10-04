"use client";
import { useMemo, useState } from "react";
import { CATEGORIES, type Category, type Counts, type HealthItem, type Status } from "../engine";

interface Data { items: HealthItem[]; byCategory: Record<Category, Counts>; totals: Counts }

const API = "/api/tools/health";
const LABEL: Record<Status, string> = { complete: "Complete", attention: "Needs attention", missing: "Missing", not_applicable: "Not applicable", unknown: "Not tracked yet" };
const STYLE: Record<Status, string> = {
  complete: "border-emerald-700 bg-emerald-950 text-emerald-200",
  attention: "border-amber-700 bg-amber-950 text-amber-200",
  missing: "border-red-800 bg-red-950 text-red-200",
  not_applicable: "border-slate-700 bg-slate-900 text-slate-400",
  unknown: "border-slate-600 bg-slate-800 text-slate-300",
};
const inputCls = "rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm";

export default function HealthDashboard({ initial, canWrite }: { initial: Data; canWrite: boolean }) {
  const [data, setData] = useState(initial);
  const [filter, setFilter] = useState<"all" | "open" | Status>("open");
  const [cat, setCat] = useState<"all" | Category>("all");
  const [error, setError] = useState<string>();

  async function reload() {
    const r = await fetch(`${API}/items`);
    if (r.ok) setData(await r.json());
  }
  async function confirm(id: string, status: "complete" | "not_applicable", note: string) {
    setError(undefined);
    const r = await fetch(`${API}/confirmations/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, note }) });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Could not save");
    await reload();
  }
  async function clear(id: string) {
    const r = await fetch(`${API}/confirmations/${id}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Could not undo");
    await reload();
  }

  const shown = useMemo(
    () =>
      data.items.filter((i) => {
        if (cat !== "all" && i.category !== cat) return false;
        if (filter === "all") return true;
        if (filter === "open") return i.status === "attention" || i.status === "missing";
        return i.status === filter;
      }),
    [data.items, filter, cat],
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 text-slate-100">
      <header>
        <p className="mt-1 text-sm text-slate-400">
          What you may be forgetting, based on your business profile and what your other tools know. There is no score: each item is either handled, needs a look, missing, or not tracked yet. These are prompts to check, not legal or financial advice.
        </p>
      </header>
      {!canWrite && <p className="text-xs text-slate-500">You have view-only access.</p>}

      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Categories">
        {CATEGORIES.map((c) => {
          const n = data.byCategory[c];
          const total = Object.values(n).reduce((a, b) => a + b, 0);
          return (
            <button key={c} onClick={() => setCat(cat === c ? "all" : c)} aria-pressed={cat === c} className={`rounded-xl border bg-slate-900 p-4 text-left ${cat === c ? "border-slate-300" : "border-slate-800"}`}>
              <div className="flex items-baseline justify-between"><h2 className="font-medium">{c}</h2><span className="text-xs text-slate-500">{total} items</span></div>
              {total === 0 ? <p className="mt-2 text-xs text-slate-500">Nothing to check for your business right now.</p> : (
                <ul className="mt-2 grid grid-cols-2 gap-x-3 text-xs text-slate-300">
                  <li>{n.complete} complete</li><li>{n.attention} need attention</li><li>{n.missing} missing</li><li>{n.unknown} not tracked yet</li>
                  {n.not_applicable > 0 && <li>{n.not_applicable} not applicable</li>}
                </ul>
              )}
            </button>
          );
        })}
      </section>

      <section className="flex flex-wrap items-end gap-3" aria-label="Filters">
        <label className="text-xs text-slate-400">Show
          <select className={`${inputCls} mt-1 block`} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="open">Needs attention or missing</option>
            <option value="all">Everything</option>
            {(Object.keys(LABEL) as Status[]).map((s) => <option key={s} value={s}>{LABEL[s]}</option>)}
          </select>
        </label>
        {cat !== "all" && <button className="text-xs underline" onClick={() => setCat("all")}>Show all categories</button>}
      </section>
      {error && <p className="text-sm text-red-300" role="alert">{error}</p>}

      {shown.length === 0 && <p className="text-sm text-slate-400">Nothing matches this filter.</p>}
      <ul className="space-y-3">
        {shown.map((i) => <Row key={i.id} item={i} canWrite={canWrite} onConfirm={confirm} onClear={clear} />)}
      </ul>
    </div>
  );
}

function Row({ item: i, canWrite, onConfirm, onClear }: { item: HealthItem; canWrite: boolean; onConfirm: (id: string, s: "complete" | "not_applicable", note: string) => Promise<void>; onClear: (id: string) => Promise<void> }) {
  const [note, setNote] = useState(i.note);
  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs uppercase text-slate-500">{i.category}</p>
          <h3 className="font-medium">{i.title}</h3>
          <p className="mt-1 text-sm text-slate-300">{i.detail}</p>
          <p className="mt-1 text-xs text-slate-400">{i.reason}{i.confirmedAt && i.note ? ` Note: ${i.note}` : ""}</p>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${STYLE[i.status]}`}>{LABEL[i.status]}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <a className="rounded-lg border border-slate-600 px-2 py-1 underline" href={i.href}>Open {i.toolName}</a>
        {canWrite && i.source === "facts" && i.status !== "complete" && (
          <>
            <input aria-label={`Note for ${i.title}`} className={`${inputCls} w-48`} placeholder="Note (optional)" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
            <button className="rounded-lg border border-slate-600 px-2 py-1" onClick={() => onConfirm(i.id, "complete", note)}>It&apos;s done outside here</button>
            <button className="rounded-lg border border-slate-700 px-2 py-1 text-slate-400" onClick={() => onConfirm(i.id, "not_applicable", note)}>Not applicable</button>
          </>
        )}
        {canWrite && i.source === "confirmed" && <button className="rounded-lg border border-slate-700 px-2 py-1 text-slate-400" onClick={() => onClear(i.id)}>Undo my confirmation</button>}
      </div>
    </li>
  );
}
