"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ENTITY_TYPES, GOALS, OPERATION_QUESTIONS, STAGES, type Business } from "@/lib/business-options";
import { US_STATES } from "@/lib/states";

const field = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400";
const label = "block text-sm text-slate-300";

export default function BusinessForm({ business }: { business?: Business }) {
  const router = useRouter();
  const [f, setF] = useState({
    name: business?.name ?? "",
    description: business?.description ?? "",
    industry: business?.industry ?? "",
    entityType: business?.entityType ?? "not_sure",
    country: business?.country ?? "United States",
    state: business?.state ?? "",
    city: business?.city ?? "",
    website: business?.website ?? "",
    lifecycleStage: business?.lifecycleStage ?? "idea",
    employeeCount: business?.employeeCount != null ? String(business.employeeCount) : "",
    operations: (business?.operations ?? {}) as Record<string, boolean>,
    goals: business?.goals ?? [],
  });
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  const toggleGoal = (g: string) => set("goals", f.goals.includes(g) ? f.goals.filter((x) => x !== g) : [...f.goals, g]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const body = { ...f, employeeCount: f.employeeCount === "" ? null : Number(f.employeeCount) };
      const r = await fetch(business ? `/api/business/${business.id}` : "/api/business", {
        method: business ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Something went wrong");
      if (business) {
        setSaved(true);
        router.refresh();
      } else {
        router.replace("/app/dashboard");
        router.refresh();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-6">
      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-medium">About your business</h2>
        <label className={label}>Business name
          <input className={field} value={f.name} onChange={(e) => set("name", e.target.value)} required maxLength={150} placeholder="Acme Cleaning LLC" />
        </label>
        <label className={label}>What does it do?
          <textarea className={field} rows={2} value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="Residential cleaning in the Charlotte area" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={label}>Industry
            <input className={field} value={f.industry} onChange={(e) => set("industry", e.target.value)} placeholder="Home services" />
          </label>
          <label className={label}>Stage
            <select className={field} value={f.lifecycleStage} onChange={(e) => set("lifecycleStage", e.target.value)}>
              {STAGES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-medium">Structure and location</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={label}>How is it set up?
            <select className={field} value={f.entityType} onChange={(e) => set("entityType", e.target.value)}>
              {ENTITY_TYPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
          <label className={label}>State
            <select className={field} value={f.state} onChange={(e) => set("state", e.target.value)}>
              <option value="">Choose a state</option>
              {US_STATES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </label>
          <label className={label}>City
            <input className={field} value={f.city} onChange={(e) => set("city", e.target.value)} />
          </label>
          <label className={label}>Website
            <input className={field} value={f.website} onChange={(e) => set("website", e.target.value)} placeholder="https://" />
          </label>
          <label className={label}>People on the team
            <input className={field} type="number" min={0} value={f.employeeCount} onChange={(e) => set("employeeCount", e.target.value)} />
          </label>
        </div>
        <p className="text-xs text-slate-500">This is for organizing your workspace. It is not legal advice about which structure to choose.</p>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-medium">How the business operates</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {OPERATION_QUESTIONS.map((q) => (
            <label key={q.key} className="flex items-center gap-2 text-sm text-slate-300">
              <input type="checkbox" checked={Boolean(f.operations[q.key])} onChange={(e) => set("operations", { ...f.operations, [q.key]: e.target.checked })} />
              {q.label}
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-medium">What do you want help with?</h2>
        <div className="flex flex-wrap gap-2">
          {GOALS.map((g) => (
            <button type="button" key={g} onClick={() => toggleGoal(g)} aria-pressed={f.goals.includes(g)}
              className={`rounded-full border px-3 py-1 text-sm ${f.goals.includes(g) ? "border-slate-100 bg-slate-100 text-slate-900" : "border-slate-700 text-slate-300"}`}>
              {g}
            </button>
          ))}
        </div>
      </section>

      {error && <div role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">{error}</div>}
      {saved && <div className="rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-200">Saved.</div>}
      <button disabled={busy} className="rounded-lg bg-slate-100 px-5 py-2.5 font-medium text-slate-900 disabled:opacity-60">
        {business ? "Save changes" : "Create my workspace"}
      </button>
    </form>
  );
}
