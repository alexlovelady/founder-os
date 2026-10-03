"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface OverrideLimitField { key: string; label: string; byPlan: Record<string, number | null>; current: string }

/** Set, replace or clear a plan override. Limit fields left blank inherit the chosen plan's value; type "unlimited" for no limit. */
export default function PlanOverrideForm({ businessId, plans, limits, current }: {
  businessId: string;
  plans: { id: string; name: string }[];
  limits: OverrideLimitField[];
  current: { plan: string; reason: string } | null;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState(current?.plan ?? plans[0]?.id ?? "free");
  const [reason, setReason] = useState(current?.reason ?? "");
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(limits.map((l) => [l.key, l.current])));
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(method: "PUT" | "DELETE") {
    setBusy(true);
    setMsg("");
    let body: string | undefined;
    if (method === "PUT") {
      const out: Record<string, number | null> = {};
      for (const [k, raw] of Object.entries(vals)) {
        const v = raw.trim().toLowerCase();
        if (!v) continue;
        if (v === "unlimited") out[k] = null;
        else if (/^\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
        else {
          setMsg(`"${k}" must be a number or "unlimited"`);
          setBusy(false);
          return;
        }
      }
      body = JSON.stringify({ plan, limits: Object.keys(out).length ? out : null, reason });
    }
    const r = await fetch(`/api/admin/businesses/${businessId}/plan-override`, { method, headers: { "content-type": "application/json" }, body });
    setBusy(false);
    if (r.ok) {
      setMsg(method === "PUT" ? "Override saved" : "Override cleared");
      router.refresh();
    } else setMsg(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save");
  }

  const input = "mt-1 block rounded border border-slate-700 bg-slate-950 p-1 text-sm text-slate-100";
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void send("PUT"); }}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-slate-400">Plan
          <select value={plan} onChange={(e) => setPlan(e.target.value)} className={input}>{plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </label>
        <label className="min-w-64 flex-1 text-xs text-slate-400">Reason (required, audited)
          <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className={`${input} w-full`} />
        </label>
      </div>
      <fieldset className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <legend className="mb-1 text-xs text-slate-400">Per-limit overrides (blank = use the plan&apos;s value)</legend>
        {limits.map((l) => (
          <label key={l.key} className="text-xs text-slate-400">{l.label}
            <input value={vals[l.key] ?? ""} onChange={(e) => setVals({ ...vals, [l.key]: e.target.value })} placeholder={l.byPlan[plan] === null || l.byPlan[plan] === undefined ? "unlimited" : String(l.byPlan[plan])} className={`${input} w-full`} />
          </label>
        ))}
      </fieldset>
      <div className="flex items-center gap-3">
        <button disabled={busy || !reason.trim()} className="rounded bg-sky-600 px-3 py-1 text-sm text-white hover:bg-sky-500 disabled:opacity-50">{current ? "Update override" : "Set override"}</button>
        {current && <button type="button" disabled={busy} onClick={() => void send("DELETE")} className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-800">Clear override</button>}
        <span className="text-xs text-slate-400" role="status">{msg}</span>
      </div>
    </form>
  );
}
