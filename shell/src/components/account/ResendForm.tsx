"use client";
import { useState, type FormEvent } from "react";
import { btnCls, inputCls, postJson } from "./shared";

export default function ResendForm({ emailAvailable }: { emailAvailable: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string }>();
  if (!emailAvailable) return <p className="text-sm text-slate-400">Email is not configured, so new links cannot be sent. Ask your administrator.</p>;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(undefined);
    const r = await postJson("/api/account/resend-verification", { email });
    setBusy(false);
    setMsg(r.ok ? { kind: "ok", text: String(r.data.message ?? "") } : { kind: "error", text: String(r.data.error ?? "Something went wrong. Try again.") });
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block text-sm">
        Did not get it? Enter your email and we will send a new link.
        <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
      </label>
      {msg && <div role={msg.kind === "ok" ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-950 text-emerald-200" : "bg-red-950 text-red-200"}`}>{msg.text}</div>}
      <button disabled={busy} className={btnCls}>{busy ? "Sending..." : "Send a new link"}</button>
    </form>
  );
}
