import FeedbackStatusButton from "@/components/platform/FeedbackStatusButton";
import { db } from "@/lib/db";
import { listFeedback } from "@/lib/platform/feedback";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export default async function AdminFeedback() {
  await requireAdminPage();
  const rows = await listFeedback(db(), { limit: 200 });
  return (
    <>
      <h1 className="text-2xl font-semibold">Feedback inbox</h1>
      <ul className="space-y-3">
        {rows.map((f) => (
          <li key={f.id} className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm">
            <div className="mb-1 flex flex-wrap items-center gap-3 text-xs text-slate-400">
              <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-200">{f.kind}</span>
              <span>{f.createdAt.slice(0, 16).replace("T", " ")}</span><span className="font-mono">{f.userId}</span><span>{f.page}</span>
              <span className={f.status === "new" ? "text-amber-400" : "text-emerald-400"}>{f.status}</span>
              <span className="ml-auto"><FeedbackStatusButton id={f.id} status={f.status} /></span>
            </div>
            <p className="whitespace-pre-wrap break-words">{f.message}</p>
            <p className="mt-1 truncate text-xs text-slate-600">{f.userAgent}</p>
          </li>
        ))}
      </ul>
      {rows.length === 0 && <p className="text-sm text-slate-400">No feedback yet.</p>}
    </>
  );
}
