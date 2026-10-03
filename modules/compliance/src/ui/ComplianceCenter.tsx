"use client";
import { useMemo, useState } from "react";
import { LinkedItems } from "@founderos/sdk/ui";
import { CATEGORIES, type ItemStatus } from "../engine";
import type { ItemDto, ListDto } from "../types";

const API = "/api/tools/compliance";
const STATUS_LABEL: Record<ItemStatus, string> = { complete: "Complete", attention: "Needs attention", missing: "Not confirmed yet", not_applicable: "Not applicable" };
const STATUS_STYLE: Record<ItemStatus, string> = {
  complete: "border-emerald-700 bg-emerald-950 text-emerald-200",
  attention: "border-amber-700 bg-amber-950 text-amber-200",
  missing: "border-slate-600 bg-slate-800 text-slate-200",
  not_applicable: "border-slate-700 bg-slate-900 text-slate-400",
};
const inputCls = "rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm";

async function api(path: string, method: string, body?: unknown): Promise<{ ok: boolean; data: { error?: string; [k: string]: unknown } }> {
  const r = await fetch(`${API}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(() => ({})) };
}

export default function ComplianceCenter({ initial, canWrite, focusId, profileState }: { initial: ListDto; canWrite: boolean; focusId: string | null; profileState: string }) {
  const [data, setData] = useState(initial);
  const [statusFilter, setStatusFilter] = useState<"all" | ItemStatus | "open">("open");
  const [catFilter, setCatFilter] = useState("all");
  const [q, setQ] = useState("");
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);

  async function reload() {
    const r = await api("items", "GET");
    if (r.ok) setData(r.data as unknown as ListDto);
  }
  async function patch(id: string, body: Record<string, unknown>) {
    setError(undefined);
    const r = await api(`items/${id}`, "PATCH", body);
    if (!r.ok) { setError(r.data.error ?? "Could not save"); return; }
    await reload();
  }
  async function renew(id: string) {
    const r = await api(`items/${id}/renew`, "POST");
    if (!r.ok) setError(r.data.error ?? "Could not start the next cycle");
    await reload();
  }
  async function remove(id: string) {
    const r = await api(`items/${id}`, "DELETE");
    if (!r.ok) setError(r.data.error ?? "Could not delete");
    await reload();
  }

  const shown = useMemo(
    () =>
      data.items.filter((i) => {
        if (statusFilter === "open" ? !(i.status === "missing" || i.status === "attention") : statusFilter !== "all" && i.status !== statusFilter) return false;
        if (catFilter !== "all" && i.category !== catFilter) return false;
        if (q.trim() && !`${i.title} ${i.description} ${i.notes}`.toLowerCase().includes(q.trim().toLowerCase())) return false;
        return true;
      }),
    [data.items, statusFilter, catFilter, q],
  );
  const upcoming = data.items.filter((i) => i.dueDate && (i.status === "missing" || i.status === "attention")).slice(0, 6);
  const groups = CATEGORIES.map((c) => ({ c, items: shown.filter((i) => i.category === c) })).filter((g) => g.items.length > 0);
  const s = data.summary;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 text-slate-100">
      <header>
        <h1 className="text-2xl font-semibold">Compliance Center</h1>
        <p className="mt-1 text-sm text-slate-400">
          A checklist of obligations that may apply to your business, built from a rule set and each rule&apos;s official source. It is a prompt to check, not legal advice: confirm anything important at the source or with a professional.
        </p>
      </header>

      {!profileState && (
        <p className="rounded-lg border border-amber-700 bg-amber-950 p-3 text-sm text-amber-200" role="note">
          Add your state in your business profile to see state filing and report items.
        </p>
      )}
      {!canWrite && <p className="text-xs text-slate-500">You have view-only access.</p>}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Summary">
        {[
          ["Open", s.open], ["Overdue", s.overdue], ["Due in 30 days", s.dueSoon], ["Complete", s.complete],
        ].map(([label, n]) => (
          <div key={label as string} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <div className="text-2xl font-semibold">{n}</div>
            <div className="text-xs text-slate-400">{label}</div>
          </div>
        ))}
      </section>

      {upcoming.length > 0 && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Upcoming deadlines">
          <h2 className="text-sm font-medium">Deadlines</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {upcoming.map((i) => (
              <li key={i.id} className="flex justify-between gap-3">
                <a className="underline" href={`#item-${i.id}`}>{i.title}</a>
                <span className={i.dueState === "overdue" ? "text-red-300" : "text-slate-400"}>{i.dueState === "overdue" ? "Overdue, " : ""}{i.dueDate}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-wrap items-end gap-3" aria-label="Filters">
        <label className="text-xs text-slate-400">Status
          <select className={`${inputCls} mt-1 block`} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="open">Open (not complete)</option>
            <option value="all">All</option>
            {(Object.keys(STATUS_LABEL) as ItemStatus[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-400">Category
          <select className={`${inputCls} mt-1 block`} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="flex-1 text-xs text-slate-400">Search
          <input className={`${inputCls} mt-1 block w-full`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items" />
        </label>
        {canWrite && <button className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900" onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "Add your own item"}</button>}
      </section>

      {adding && <AddItem onDone={async () => { setAdding(false); await reload(); }} />}
      {error && <p className="text-sm text-red-300" role="alert">{error}</p>}

      {groups.length === 0 && <p className="text-sm text-slate-400">Nothing matches these filters.</p>}
      {groups.map(({ c, items }) => (
        <section key={c} aria-label={c}>
          <h2 className="mb-2 text-sm font-semibold capitalize text-slate-300">{c} <span className="font-normal text-slate-500">({items.length})</span></h2>
          <ul className="space-y-3">
            {items.map((i) => <Item key={i.id} item={i} canWrite={canWrite} open={i.id === focusId} onPatch={patch} onRenew={renew} onRemove={remove} />)}
          </ul>
        </section>
      ))}

      <footer className="text-xs text-slate-500">
        Rules version {data.rulesVersion}. Sources are official pages we checked on the date shown next to each link. Fees, thresholds and due dates change and differ by state and entity type, so always confirm at the source.
      </footer>
    </div>
  );
}

function Item({ item: i, canWrite, open, onPatch, onRenew, onRemove }: { item: ItemDto; canWrite: boolean; open: boolean; onPatch: (id: string, b: Record<string, unknown>) => Promise<void>; onRenew: (id: string) => Promise<void>; onRemove: (id: string) => Promise<void> }) {
  const [expanded, setExpanded] = useState(open);
  const [notes, setNotes] = useState(i.notes);
  return (
    <li id={`item-${i.id}`} className={`rounded-xl border bg-slate-900 p-4 ${i.dueState === "overdue" ? "border-red-700" : "border-slate-800"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <button className="text-left font-medium underline-offset-2 hover:underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{i.title}</button>
          <p className="mt-1 text-sm text-slate-300">{i.recommendation || i.description}</p>
          <p className="mt-1 text-xs text-slate-500">
            {i.dueDate ? <span className={i.dueState === "overdue" ? "text-red-300" : ""}>{i.dueState === "overdue" ? "Overdue: " : "Due "}{i.dueDate}</span> : "No due date set"}
            {i.recurrence && ` · repeats ${i.recurrence}`}{i.uncertain && " · may not apply, please check"}
          </p>
        </div>
        <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_STYLE[i.status]}`}>{STATUS_LABEL[i.status]}</span>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-slate-800 pt-3">
          {i.description && i.recommendation && <p className="text-sm text-slate-400">{i.description}</p>}
          {i.sourceUrl && (
            <p className="text-xs text-slate-400">
              Source: <a className="underline" href={i.sourceUrl} target="_blank" rel="noopener noreferrer">{i.sourceTitle || i.sourceUrl}</a>
              {i.lastVerified ? ` (checked ${i.lastVerified})` : " (could not be checked automatically; confirm at source)"}
            </p>
          )}
          {canWrite ? (
            <>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Set status">
                {(Object.keys(STATUS_LABEL) as ItemStatus[]).map((k) => (
                  <button key={k} aria-pressed={i.status === k} className={`rounded-lg border px-2 py-1 text-xs ${i.status === k ? STATUS_STYLE[k] : "border-slate-700 text-slate-300"}`} onClick={() => onPatch(i.id, { status: k })}>{STATUS_LABEL[k]}</button>
                ))}
                {i.recurrence && i.status === "complete" && <button className="rounded-lg border border-slate-600 px-2 py-1 text-xs" onClick={() => onRenew(i.id)}>Start next {i.recurrence === "yearly" ? "year" : i.recurrence === "monthly" ? "month" : "quarter"}</button>}
                {i.sourceUrl && <button className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300" onClick={() => onPatch(i.id, { verifiedNow: true })}>I checked the source today</button>}
              </div>
              <label className="block text-xs text-slate-400">Due date
                <input type="date" className={`${inputCls} mt-1 block`} value={i.dueDate ?? ""} onChange={(e) => onPatch(i.id, { dueDate: e.target.value || null })} />
              </label>
              <label className="block text-xs text-slate-400">Notes
                <textarea className={`${inputCls} mt-1 block w-full`} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== i.notes && onPatch(i.id, { notes })} />
              </label>
              {i.custom && <button className="text-xs text-red-300 underline" onClick={() => onRemove(i.id)}>Delete this item</button>}
            </>
          ) : (
            i.notes && <p className="text-sm text-slate-300">Notes: {i.notes}</p>
          )}
          <LinkedItems tool="compliance" id={i.id} canWrite={canWrite} />
        </div>
      )}
    </li>
  );
}

function AddItem({ onDone }: { onDone: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("other");
  const [dueDate, setDueDate] = useState("");
  const [recurrence, setRecurrence] = useState("");
  const [error, setError] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await api("items", "POST", { title, category, dueDate: dueDate || null, recurrence: recurrence || null });
    if (!r.ok) { setError(r.data.error ?? "Could not add"); return; }
    await onDone();
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Add item">
      <label className="block text-xs text-slate-400">Title
        <input required maxLength={200} className={`${inputCls} mt-1 block w-full`} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-slate-400">Category
          <select className={`${inputCls} mt-1 block`} value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </label>
        <label className="text-xs text-slate-400">Due date
          <input type="date" className={`${inputCls} mt-1 block`} value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        <label className="text-xs text-slate-400">Repeats
          <select className={`${inputCls} mt-1 block`} value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
            <option value="">Does not repeat</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option>
          </select>
        </label>
      </div>
      {error && <p className="text-sm text-red-300" role="alert">{error}</p>}
      <button className="rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900">Add item</button>
    </form>
  );
}
