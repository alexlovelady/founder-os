"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

/** Suspend or lift a user's suspension. A reason is required for both and is written to the audit log. */
export default function SuspendButton({ userId, suspended, self }: { userId: string; suspended: boolean; self: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (self && !suspended) return <span className="text-xs text-slate-500">This is you</span>;
  if (!open) {
    return (
      <button className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800" onClick={() => setOpen(true)}>
        {suspended ? "Lift suspension" : "Suspend"}
      </button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/suspension`, {
          method: suspended ? "DELETE" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reason }),
        });
        setBusy(false);
        if (r.ok) {
          setOpen(false);
          setReason("");
          router.refresh();
        } else setMsg(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "Could not save");
      }}
    >
      <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" aria-label="Reason"
        className="w-56 rounded border border-slate-700 bg-slate-950 p-1 text-xs text-slate-100" />
      <button disabled={busy || !reason.trim()} className="rounded bg-sky-600 px-2 py-1 text-xs text-white hover:bg-sky-500 disabled:opacity-50">
        {suspended ? "Lift" : "Suspend"}
      </button>
      <button type="button" className="text-xs text-slate-400 underline" onClick={() => setOpen(false)}>Cancel</button>
      <span className="text-xs text-amber-400" role="status">{msg}</span>
    </form>
  );
}
