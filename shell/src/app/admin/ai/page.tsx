import { LEGAL_MODEL_ENV, planAiRows, probeLegal } from "@/lib/admin/ai";
import { aiRequestsThisMonth } from "@/lib/admin/usage";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export default async function AdminAi() {
  await requireAdminPage();
  const legalUrl = process.env.LEGAL_URL ?? "http://localhost:8000";
  const [probe, used] = await Promise.all([probeLegal(legalUrl), aiRequestsThisMonth(db())]);
  const rows = planAiRows();
  return (
    <>
      <h1 className="text-2xl font-semibold">AI settings</h1>
      <p className="text-sm text-slate-400">Read-only. The shell does not choose models or route requests; that lives in the LegalAI environment. Nothing on this page is a control.</p>

      <section>
        <h2 className="mb-2 font-medium">LegalAI service</h2>
        <p className="text-sm">
          <span className={probe.reachable ? "text-emerald-400" : "text-amber-400"}>{probe.reachable ? "Reachable" : "Not reachable"}</span>
          <span className="text-slate-400"> at {legalUrl}/healthz: {probe.detail}{probe.ms !== null ? ` (${probe.ms} ms)` : ""}</span>
        </p>
        <p className="text-xs text-slate-500">The health endpoint only reports ok or not ok. It does not expose which models are loaded, so the configured model names are not shown here.</p>
      </section>

      <section>
        <h2 className="mb-2 font-medium">AI requests this month</h2>
        <p className="text-sm">{used.toLocaleString("en-US")} recorded across all businesses (UTC calendar month, from usage_events).</p>
      </section>

      <section>
        <h2 className="mb-2 font-medium">Plans: AI request limits and AI tier</h2>
        <table className="w-full max-w-xl text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-1">Plan</th><th className="text-right">AI requests / month</th><th className="text-right">aiTier</th></tr></thead>
          <tbody>
            {rows.map((p) => <tr key={p.plan} className="border-t border-slate-800"><td className="py-1">{p.name}</td><td className="text-right">{p.aiRequestsPerMonth === null ? "unlimited" : p.aiRequestsPerMonth.toLocaleString("en-US")}</td><td className="text-right font-mono">{p.aiTier}</td></tr>)}
          </tbody>
        </table>
        <p className="mt-1 text-xs text-slate-500">
          aiTier says which AI a plan uses. Only &quot;local&quot; exists today: the owner&apos;s private GPU running through LegalAI. &quot;cloud&quot; and &quot;bring_your_own&quot; are reserved values in
          config/plans.ts and are not built. Limits are edited in shell/src/config/plans.ts (or per business with a plan override).
        </p>
      </section>

      <section>
        <h2 className="mb-2 font-medium">How to change models</h2>
        <p className="mb-2 text-sm text-slate-300">
          Models are set with environment variables on the LegalAI service and take effect after it restarts. The variables are defined in modules/legal/api/legalai/config.py,
          with example values in .env.example and deployment notes in docs/railway.md.
        </p>
        <table className="w-full text-left text-sm"><tbody>
          {LEGAL_MODEL_ENV.map((e) => <tr key={e.name} className="border-t border-slate-800"><td className="py-1 pr-4 font-mono">{e.name}</td><td className="text-slate-400">{e.purpose}</td></tr>)}
        </tbody></table>
        <p className="mt-2 text-xs text-slate-500">Temperature, system prompts, per-feature routing and token caps from the product spec are not configurable from this portal.</p>
      </section>
    </>
  );
}
