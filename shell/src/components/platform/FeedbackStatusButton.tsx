"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function FeedbackStatusButton({ id, status }: { id: number; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const next = status === "handled" ? "new" : "handled";
  return (
    <button
      disabled={busy}
      className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/admin/feedback/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) });
        setBusy(false);
        router.refresh();
      }}
    >
      {next === "handled" ? "Mark handled" : "Reopen"}
    </button>
  );
}
