"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function InviteAccept({ token, businessName, roleLabel, roleSummary }: { token: string; businessName: string; roleLabel: string; roleSummary: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [declined, setDeclined] = useState(false);

  async function accept() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch("/api/team/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setError(data.error ?? "Could not accept the invite.");
        return;
      }
      router.replace("/app/dashboard");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (declined) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-slate-300">You declined the invite. Nothing was changed.</p>
        <Link href="/app/dashboard" className="inline-block rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800">Go to your dashboard</Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-300">
        You have been invited to join <strong className="text-slate-100">{businessName}</strong> as <strong className="text-slate-100">{roleLabel}</strong>.
      </p>
      <p className="text-xs text-slate-400">{roleSummary}</p>
      {error && <p role="alert" className="rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-200">{error}</p>}
      <div className="flex gap-2">
        <button onClick={accept} disabled={busy} className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-900 disabled:opacity-50">{busy ? "Joining..." : "Accept"}</button>
        <button onClick={() => setDeclined(true)} disabled={busy} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-50">Decline</button>
      </div>
    </div>
  );
}
