"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ResolveButton({ id, resolved }: { id: number; resolved: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      disabled={busy}
      className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
      onClick={async () => {
        setBusy(true);
        await fetch(`/api/admin/errors/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ resolved: !resolved }) });
        setBusy(false);
        router.refresh();
      }}
    >
      {resolved ? "Reopen" : "Mark resolved"}
    </button>
  );
}
