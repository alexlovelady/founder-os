"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface Flag { key: string; description: string; enabled: boolean; rolloutPct: number; overrides: number }

export default function FlagsEditor({ flags }: { flags: Flag[] }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [draft, setDraft] = useState({ key: "", description: "" });

  async function save(f: { key: string; description: string; enabled: boolean; rolloutPct: number }) {
    setError("");
    const r = await fetch("/api/admin/flags", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(f) });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Could not save");
    else router.refresh();
  }

  return (
    <div className="space-y-4">
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      <table className="w-full text-left text-sm">
        <thead className="text-slate-400"><tr><th className="py-2">Flag</th><th>On</th><th>Rollout %</th><th>Overrides</th></tr></thead>
        <tbody>
          {flags.map((f) => (
            <tr key={f.key} className="border-t border-slate-800">
              <td className="py-2 pr-4"><div className="font-mono text-slate-100">{f.key}</div><div className="text-xs text-slate-500">{f.description}</div></td>
              <td>
                <input type="checkbox" aria-label={`${f.key} enabled`} checked={f.enabled} onChange={(e) => save({ ...f, enabled: e.target.checked })} />
              </td>
              <td>
                <input
                  type="number" min={0} max={100} aria-label={`${f.key} rollout percent`} defaultValue={f.rolloutPct}
                  className="w-20 rounded border border-slate-700 bg-slate-950 p-1"
                  onBlur={(e) => {
                    const v = Math.min(100, Math.max(0, Math.round(Number(e.target.value))));
                    if (Number.isFinite(v) && v !== f.rolloutPct) save({ ...f, rolloutPct: v });
                  }}
                />
              </td>
              <td className="text-slate-400">{f.overrides}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await save({ key: draft.key, description: draft.description, enabled: false, rolloutPct: 100 });
          setDraft({ key: "", description: "" });
        }}
      >
        <label className="text-xs text-slate-400">New flag key<input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} placeholder="my_flag_enabled" className="mt-1 block rounded border border-slate-700 bg-slate-950 p-1 text-sm text-slate-100" /></label>
        <label className="text-xs text-slate-400">Description<input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-1 block rounded border border-slate-700 bg-slate-950 p-1 text-sm text-slate-100" /></label>
        <button className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500">Add (starts off)</button>
      </form>
    </div>
  );
}
