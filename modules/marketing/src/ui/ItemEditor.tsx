"use client";
import { useState } from "react";
import { LinkedItems } from "@founderos/sdk/ui";
import { KIND_LABEL, KINDS, type ItemKind } from "../prompts";
import { api, btn, btn2, input, type Item } from "./shared";

export default function ItemEditor({ initial, canWrite }: { initial: Item; canWrite: boolean }) {
  const [item, setItem] = useState(initial);
  const [f, setF] = useState({ title: initial.title, kind: initial.kind, body: initial.body ?? "", channel: initial.channel, status: initial.status, scheduledFor: initial.scheduledFor ?? "", notes: initial.notes });
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();
  const dirty = JSON.stringify(f) !== JSON.stringify({ title: item.title, kind: item.kind, body: item.body ?? "", channel: item.channel, status: item.status, scheduledFor: item.scheduledFor ?? "", notes: item.notes });

  async function save() {
    setErr(undefined); setMsg(undefined);
    const r = await api<{ item?: Item; error?: string }>(`items/${item.id}`, "PUT", { title: f.title, kind: f.kind, body: f.body, channel: f.channel, status: f.status, scheduled_for: f.scheduledFor || null, notes: f.notes });
    if (!r.ok || !r.data.item) { setErr(r.data.error ?? "Could not save"); return; }
    setItem(r.data.item); setMsg("Saved.");
  }
  async function remove() {
    if (!window.confirm("Delete this item? This cannot be undone.")) return;
    const r = await api(`items/${item.id}`, "DELETE");
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full page load is intended
    if (r.ok) window.location.href = "/app/t/marketing"; else setErr("Could not delete");
  }
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4">
      <a href="/app/t/marketing" className="text-sm text-slate-400 underline">Back to Marketing</a>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm md:col-span-2">Title<input className={input} disabled={!canWrite} value={f.title} onChange={(e) => set("title", e.target.value)} /></label>
        <label className="block text-sm">Kind<select className={input} disabled={!canWrite} value={f.kind} onChange={(e) => set("kind", e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k as ItemKind]}</option>)}</select></label>
        <label className="block text-sm">Channel<input className={input} disabled={!canWrite} value={f.channel} onChange={(e) => set("channel", e.target.value)} /></label>
        <label className="block text-sm">Status
          <select className={input} disabled={!canWrite} value={f.status} onChange={(e) => set("status", e.target.value)}><option value="draft">Draft</option><option value="ready">Ready</option><option value="published">Published (you posted it yourself)</option></select>
        </label>
        <label className="block text-sm">Planned date (a reminder only; nothing is posted)<input type="date" className={input} disabled={!canWrite} value={f.scheduledFor} onChange={(e) => set("scheduledFor", e.target.value)} /></label>
      </div>
      <label className="block text-sm">Copy<textarea className={`${input} h-72`} readOnly={!canWrite} value={f.body} onChange={(e) => set("body", e.target.value)} /></label>
      <label className="block text-sm">Notes<textarea className={`${input} h-20`} readOnly={!canWrite} value={f.notes} onChange={(e) => set("notes", e.target.value)} /></label>
      <div className="flex flex-wrap gap-2">
        {canWrite && <button className={btn} disabled={!dirty || !f.title.trim()} onClick={save}>Save</button>}
        <button className={btn2} onClick={() => void navigator.clipboard?.writeText(f.body).then(() => setMsg("Copied to clipboard."))}>Copy text</button>
        {canWrite && <button className={btn2} onClick={remove}>Delete</button>}
      </div>
      {msg && <p className="text-sm text-emerald-300" role="status">{msg}</p>}
      {err && <p className="text-sm text-red-300" role="alert">{err}</p>}
      <LinkedItems tool="marketing" id={item.id} canWrite={canWrite} />
    </div>
  );
}
