"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RunBackupButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  return (
    <span className="inline-flex items-center gap-3">
      <button
        disabled={busy || disabled}
        className="rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50"
        onClick={async () => {
          setBusy(true);
          setMsg("Running (this can take a minute)...");
          const r = await fetch("/api/admin/backups", { method: "POST" }).catch(() => null);
          const j = r ? await r.json().catch(() => null) : null;
          setMsg(j?.ok ? (j.state === "busy" ? "Another backup is already running." : "Backup finished.") : `Failed: ${j?.detail ?? "request failed"}`);
          setBusy(false);
          router.refresh();
        }}
      >
        Run backup now
      </button>
      {msg && <span className="text-xs text-slate-400">{msg}</span>}
    </span>
  );
}
