"use client";
import { useState } from "react";

/** Upgrade / manage buttons. The server decides everything; this only posts the plan name and follows the Stripe link it returns. */
export function PlanButton({ plan, label, disabled, reason }: { plan: string; label: string; disabled: boolean; reason?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function go() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch("/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.url) window.location.href = d.url;
      else setError(d.error ?? "Could not start checkout");
    } catch {
      setError("Could not reach the server");
    }
    setBusy(false);
  }
  return (
    <div>
      <button
        onClick={go}
        disabled={disabled || busy}
        title={reason}
        className="w-full rounded-md bg-indigo-500 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
      >
        {busy ? "Opening..." : label}
      </button>
      {disabled && reason && <p className="mt-1 text-xs text-slate-500">{reason}</p>}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function ManageButton({ disabled, reason }: { disabled: boolean; reason?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  async function go() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await fetch("/api/billing/portal", { method: "POST" });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.url) window.location.href = d.url;
      else setError(d.error ?? "Could not open the billing portal");
    } catch {
      setError("Could not reach the server");
    }
    setBusy(false);
  }
  return (
    <div>
      <button
        onClick={go}
        disabled={disabled || busy}
        title={reason}
        className="rounded-md border border-slate-600 px-3 py-2 text-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500"
      >
        {busy ? "Opening..." : "Manage subscription"}
      </button>
      {disabled && reason && <p className="mt-1 text-xs text-slate-500">{reason}</p>}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
