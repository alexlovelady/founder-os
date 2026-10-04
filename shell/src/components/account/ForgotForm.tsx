"use client";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { btnCls, cardCls, inputCls, postJson } from "./shared";

export default function ForgotForm({ emailAvailable }: { emailAvailable: boolean }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string }>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(undefined);
    const r = await postJson("/api/account/forgot", { email });
    setBusy(false);
    if (r.ok) setMsg({ kind: "ok", text: String(r.data.message ?? "") });
    else setMsg({ kind: "error", text: String(r.data.error ?? "Something went wrong. Try again.") });
  }

  if (!emailAvailable) {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-semibold">Forgot your password?</h1>
        <p role="status" className="text-sm text-slate-300">Password reset by email is not available yet. Ask your administrator for a reset link.</p>
        <Link href="/login" className="inline-block text-sm underline">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className={cardCls}>
      <h1 className="text-xl font-semibold">Forgot your password?</h1>
      <p className="text-sm text-slate-400">Enter the email address of your account and we will send you a link to choose a new password.</p>
      <label className="block text-sm">
        Email
        <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" />
      </label>
      {msg && (
        <div role={msg.kind === "ok" ? "status" : "alert"} className={`rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-950 text-emerald-200" : "bg-red-950 text-red-200"}`}>
          {msg.text}
        </div>
      )}
      <button disabled={busy} className={btnCls}>{busy ? "Sending..." : "Send reset link"}</button>
      <p className="text-sm text-slate-400"><Link href="/login" className="underline">Back to sign in</Link></p>
    </form>
  );
}
