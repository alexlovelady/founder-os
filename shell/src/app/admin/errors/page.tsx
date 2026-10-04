import Link from "next/link";
import { db } from "@/lib/db";
import { listErrors, ERROR_RETENTION_DAYS } from "@/lib/ops/errors";
import { requireAdminPage } from "@/lib/platform/http";
import ResolveButton from "./ResolveButton";

export const dynamic = "force-dynamic";

export default async function AdminErrors({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireAdminPage();
  const { status } = await searchParams;
  const filter = status === "resolved" || status === "all" ? status : "open";
  const rows = await listErrors(db(), { status: filter });
  const tab = (v: string, label: string) => (
    <Link href={`/admin/errors?status=${v}`} className={filter === v ? "font-semibold text-white" : "text-slate-400 hover:text-white"}>{label}</Link>
  );
  return (
    <>
      <h1 className="text-2xl font-semibold">Errors</h1>
      <p className="text-sm text-slate-400">
        Server errors (pages, route handlers, server actions, background jobs), grouped by route + message + first stack frame. Messages and stacks are scrubbed of tokens, emails and query strings;
        no user or request data is stored. Groups not seen for {ERROR_RETENTION_DAYS} days are deleted daily. <strong>Not captured:</strong> errors in the browser, errors the app catches itself, and crashes of the whole process
        (use Railway logs for those; they are structured JSON). {process.env.SENTRY_DSN ? "Also forwarding to Sentry." : "Sentry forwarding is off (set SENTRY_DSN to enable)."}
      </p>
      <div className="flex gap-4 text-sm">{tab("open", "Open")}{tab("resolved", "Resolved")}{tab("all", "All")}</div>
      <ul className="space-y-3">
        {rows.map((e) => (
          <li key={e.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm">
            <div className="mb-1 flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <span className="rounded bg-red-900/60 px-2 py-0.5 text-red-200">{e.count}x</span>
              <span className="font-mono text-slate-200">{e.method} {e.route || "(no route)"}</span>
              <span>first {e.firstSeen.slice(0, 16).replace("T", " ")}</span><span>last {e.lastSeen.slice(0, 16).replace("T", " ")}</span>
              <span className={e.status === "open" ? "text-amber-400" : "text-emerald-400"}>{e.status}</span>
              <span className="ml-auto"><ResolveButton id={e.id} resolved={e.status === "resolved"} /></span>
            </div>
            <p className="break-words">{e.message}</p>
            {e.stack && <details className="mt-1"><summary className="cursor-pointer text-xs text-slate-500">Stack</summary><pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-slate-400">{e.stack}</pre></details>}
            <p className="mt-1 font-mono text-xs text-slate-600">{e.fingerprint}</p>
          </li>
        ))}
      </ul>
      {rows.length === 0 && <p className="text-sm text-slate-400">Nothing here{filter === "open" ? ": no open errors." : "."}</p>}
    </>
  );
}
