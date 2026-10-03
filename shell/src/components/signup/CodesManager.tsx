"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export interface CodeRow { id: string; label: string; maxUses: number; useCount: number; expiresAt: string | null; createdAt: string; revokedAt: string | null; status: string }

const field = "rounded border border-slate-700 bg-slate-950 p-1.5 text-sm";

export default function CodesManager({ codes }: { codes: CodeRow[] }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [days, setDays] = useState(14);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState<string>();

  async function create(e: FormEvent) {
    e.preventDefault();
    setError("");
    setFresh(undefined);
    const r = await fetch("/api/admin/signup/codes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, maxUses, expiresInDays: days > 0 ? days : null }),
    });
    const d = (await r.json().catch(() => ({}))) as { code?: string; error?: string };
    if (!r.ok || !d.code) return setError(d.error ?? "Could not create the code");
    setFresh(d.code);
    setLabel("");
    router.refresh();
  }

  async function revoke(id: string) {
    setError("");
    const r = await fetch(`/api/admin/signup/codes/${id}`, { method: "DELETE" });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error ?? "Could not revoke");
    else router.refresh();
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap items-end gap-3">
        <label className="text-sm">Label<br /><input className={`${field} w-48`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} placeholder="e.g. Beta cohort 1" /></label>
        <label className="text-sm">Max uses<br /><input className={`${field} w-24`} type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))} /></label>
        <label className="text-sm">Expires in days (0 = never)<br /><input className={`${field} w-24`} type="number" min={0} max={365} value={days} onChange={(e) => setDays(Math.max(0, Number(e.target.value) || 0))} /></label>
        <button className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900">Create code</button>
      </form>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {fresh && (
        <div role="status" className="rounded-lg border border-emerald-800 bg-emerald-950 p-3 text-sm">
          <p className="text-emerald-200">Copy this code now. It is shown once and cannot be recovered (only a hash is stored).</p>
          <p className="mt-1 select-all font-mono text-base text-white">{fresh}</p>
        </div>
      )}
      <table className="w-full text-left text-sm">
        <thead className="text-slate-400"><tr><th className="py-2">Label</th><th>Status</th><th>Used</th><th>Expires</th><th>Created</th><th /></tr></thead>
        <tbody>
          {codes.length === 0 && <tr><td colSpan={6} className="py-3 text-slate-500">No invite codes yet.</td></tr>}
          {codes.map((c) => (
            <tr key={c.id} className="border-t border-slate-800">
              <td className="py-2 pr-3">{c.label || <span className="text-slate-500">(no label)</span>}</td>
              <td>{c.status}</td>
              <td>{c.useCount} / {c.maxUses}</td>
              <td>{c.expiresAt ? new Date(c.expiresAt).toLocaleDateString() : "never"}</td>
              <td>{new Date(c.createdAt).toLocaleDateString()}</td>
              <td className="text-right">
                {c.status === "active" && <button onClick={() => revoke(c.id)} className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800" aria-label={`Revoke code ${c.label || c.id}`}>Revoke</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
