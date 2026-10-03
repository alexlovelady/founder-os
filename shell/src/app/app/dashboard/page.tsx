import Link from "next/link";
import { MODULES } from "@/config/modules";

export default function Dashboard() {
  return (
    <div className="mx-auto max-w-4xl space-y-8 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Your business workspace</h1>
        <p className="mt-1 text-slate-400">Sign-in and business profiles are not connected yet, so this is a preview of the layout. Tools marked live are real.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {MODULES.map((m) => (
          <div key={m.id} className="rounded-xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{m.name}</h2>
              <span className={`rounded px-2 py-0.5 text-xs ${m.status === "live" ? "bg-emerald-900 text-emerald-200" : "bg-slate-800 text-slate-400"}`}>{m.status === "live" ? "Live" : "Planned"}</span>
            </div>
            <p className="mt-2 text-sm text-slate-400">{m.tagline}</p>
            {m.status === "live" && <Link href={m.route} className="mt-4 inline-block rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900">Open</Link>}
          </div>
        ))}
      </div>
    </div>
  );
}
