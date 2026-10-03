"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface StaleRow {
  ruleId: string; title: string; origin: "seed" | "admin"; status: string | null; sourceTitle: string; sourceUrl: string; lastVerified: string | null; ageDays: number | null;
}

/** Spec 62 stale-rules queue. Admin rules can be marked verified here; seed rules live in code, so they are only reported. */
export default function StaleQueue({ rows }: { rows: StaleRow[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(row: StaleRow, action: "verify" | "check") {
    const slug = row.ruleId.replace(/^admin:/, "");
    setBusy(`${row.ruleId}:${action}`);
    setMsg(null);
    try {
      const r = await fetch(`/api/admin/compliance/${slug}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) setMsg({ ok: false, text: j.error ?? "Failed" });
      else { setMsg({ ok: true, text: j.result?.note ?? "Marked verified today." }); router.refresh(); }
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) return <p className="text-sm text-slate-400">No rule is older than 180 days.</p>;
  return (
    <div className="space-y-2">
      {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-slate-400"><tr><th className="py-2">Rule</th><th>Where</th><th>Last verified</th><th>Age</th><th>Source</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ruleId} className="border-t border-slate-800 align-top">
                <td className="py-2 pr-3">{r.origin === "admin" ? <Link className="underline" href={`/admin/compliance/${r.ruleId.replace(/^admin:/, "")}`}>{r.title || r.ruleId}</Link> : r.title}<div className="font-mono text-xs text-slate-500">{r.ruleId}</div></td>
                <td className="pr-3 text-xs">{r.origin === "admin" ? `admin (${r.status})` : "code seed"}</td>
                <td className="pr-3 whitespace-nowrap">{r.lastVerified ?? "never"}</td>
                <td className="pr-3 whitespace-nowrap">{r.ageDays === null ? "-" : `${r.ageDays} days`}</td>
                <td className="pr-3 text-xs">{r.sourceUrl ? <a className="break-all underline" href={r.sourceUrl} target="_blank" rel="noopener noreferrer">{r.sourceTitle || r.sourceUrl}</a> : "none"}</td>
                <td className="whitespace-nowrap text-right">
                  {r.origin === "admin" ? (
                    <div className="flex justify-end gap-1">
                      <button disabled={busy !== null || !r.sourceUrl} onClick={() => act(r, "check")} className="rounded bg-slate-700 px-2 py-1 text-xs text-white hover:bg-slate-600 disabled:opacity-50">Check source</button>
                      <button disabled={busy !== null} onClick={() => act(r, "verify")} className="rounded bg-sky-700 px-2 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50">Mark verified today</button>
                    </div>
                  ) : <span className="text-xs text-slate-500">In code: re-verify the source, then update seed.ts</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
