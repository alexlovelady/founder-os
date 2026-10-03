import Link from "next/link";
import { RULES } from "@founderos/compliance/src/seed";
import { listAdminRules, loadStaleQueue } from "@founderos/compliance/src/admin-rules";
import { toYmd } from "@founderos/compliance/src/engine";
import StaleQueue from "@/components/admin/compliance/StaleQueue";
import { db } from "@/lib/db";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

const STATUS_STYLE = { draft: "bg-slate-800 text-slate-300", published: "bg-emerald-900 text-emerald-200", disabled: "bg-amber-900 text-amber-200" } as const;

export default async function AdminCompliance() {
  await requireAdminPage();
  const sql = db();
  const today = toYmd(new Date());
  const [rules, stale] = await Promise.all([listAdminRules(sql), loadStaleQueue(sql, today)]);
  const federal = RULES.filter((r) => !r.id.startsWith("state-"));
  const states = RULES.length - federal.length;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Compliance rules</h1>
        <Link href="/admin/compliance/new" className="rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500">New rule</Link>
      </div>
      <p className="text-sm text-slate-400">
        Published admin rules are added to the built-in rules for every business at its next checklist sync. Every rule needs an https source and a last-verified date. Rules apply to all
        businesses by their profile: there are no per-business custom rules. Changes are audited. This is a reminder checklist, not legal advice.
      </p>

      <section aria-labelledby="stale">
        <h2 id="stale" className="mb-2 text-lg font-medium">Stale rules ({stale.length})</h2>
        <p className="mb-2 text-xs text-slate-500">Last verified more than 180 days ago, or never. Oldest first.</p>
        <StaleQueue rows={stale} />
      </section>

      <section aria-labelledby="admin-rules">
        <h2 id="admin-rules" className="mb-2 text-lg font-medium">Admin rules ({rules.length})</h2>
        {rules.length === 0 ? <p className="text-sm text-slate-400">None yet. Create one to add compliance content beyond the built-in rules.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-400"><tr><th className="py-2">Rule</th><th>Status</th><th>Version</th><th>Jurisdiction</th><th>Last verified</th><th>Source check</th></tr></thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.slug} className="border-t border-slate-800 align-top">
                    <td className="py-2 pr-3"><Link className="underline" href={`/admin/compliance/${r.slug}`}>{r.content.title}</Link><div className="font-mono text-xs text-slate-500">{r.ruleId}</div></td>
                    <td className="pr-3"><span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[r.status]}`}>{r.status}</span></td>
                    <td className="pr-3">v{r.version}</td>
                    <td className="pr-3">{r.content.jurisdiction}</td>
                    <td className="pr-3 whitespace-nowrap">{r.content.lastVerified ?? "never"}</td>
                    <td className="text-xs text-slate-400">{r.lastCheck ? `${r.lastCheck.status ?? "not fetched"} on ${r.lastCheck.at.slice(0, 10)}` : "not checked"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="seed-rules">
        <h2 id="seed-rules" className="mb-2 text-lg font-medium">Built-in rules ({RULES.length}, read-only)</h2>
        <p className="mb-2 text-xs text-slate-500">These live in code (modules/compliance/src/seed.ts), including {states} generated state rules. Change them with a code change; they are listed so the whole rule set can be audited in one place.</p>
        <details>
          <summary className="cursor-pointer text-sm text-slate-300">Show all built-in rules</summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-slate-400"><tr><th className="py-2">Rule</th><th>Category</th><th>Source</th><th>Last verified</th></tr></thead>
              <tbody>
                {RULES.map((r) => (
                  <tr key={r.id} className="border-t border-slate-800 align-top">
                    <td className="py-1 pr-3">{r.title}<div className="font-mono text-xs text-slate-500">{r.id} v{r.version}</div></td>
                    <td className="pr-3 text-xs">{r.category}</td>
                    <td className="pr-3 text-xs"><a className="break-all underline" href={r.source.url} target="_blank" rel="noopener noreferrer">{r.source.title}</a></td>
                    <td className="whitespace-nowrap">{r.source.lastVerified ?? "never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </>
  );
}
