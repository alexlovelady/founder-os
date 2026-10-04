"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { MIN_PASSWORD, passwordHint } from "@/lib/signup/password";
import { btnCls, cardCls, inputCls, postJson, safeNext } from "./shared";

const HINT_COLOR = { short: "text-red-300", weak: "text-amber-300", ok: "text-slate-300", strong: "text-emerald-300" } as const;

export default function ResetForm({ token, valid }: { token: string; valid: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const hint = passwordHint(password);
  const mismatch = confirm.length > 0 && confirm !== password;

  if (!valid) {
    return (
      <div className={cardCls}>
        <h1 className="text-xl font-semibold">This link does not work</h1>
        <p role="alert" className="text-sm text-slate-300">This link is invalid, has expired, or has already been used. Request a new one.</p>
        <Link href="/forgot" className="inline-block rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900">Request a new link</Link>
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (password !== confirm) return setError("The two passwords do not match.");
    setBusy(true);
    const r = await postJson("/api/account/reset", { token, password });
    setBusy(false);
    if (r.ok) router.replace(safeNext(r.data.next, "/login?reset=1"));
    else setError(String(r.data.error ?? "Could not change the password."));
  }

  return (
    <form onSubmit={submit} className={cardCls}>
      <h1 className="text-xl font-semibold">Choose a new password</h1>
      <label className="block text-sm">
        New password
        <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={MIN_PASSWORD} maxLength={256} autoComplete="new-password" autoFocus aria-describedby="pw-hint" />
        <span id="pw-hint" aria-live="polite" className={`mt-1 block text-xs ${password ? HINT_COLOR[hint.level] : "text-slate-500"}`}>
          {password ? hint.message : `At least ${MIN_PASSWORD} characters. A passphrase of several words is easiest to remember.`}
        </span>
      </label>
      <label className="block text-sm">
        Confirm new password
        <input className={inputCls} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" aria-invalid={mismatch} />
        {mismatch && <span className="mt-1 block text-xs text-red-300">The passwords do not match yet.</span>}
      </label>
      <p className="text-xs text-slate-400">You will be signed out everywhere. If you use two-step verification, it stays on: you will still need your authenticator app or a recovery code to sign in.</p>
      {error && <div role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">{error}</div>}
      <button disabled={busy} className={btnCls}>{busy ? "Saving..." : "Change password"}</button>
    </form>
  );
}
