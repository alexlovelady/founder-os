"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { legalAuth } from "@/lib/auth/legalai";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfaToken, setMfaToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      if (mfaToken) await legalAuth.loginMfa(mfaToken, code);
      else {
        const r = await legalAuth.login(email, password);
        if (r.kind === "mfa") {
          setMfaToken(r.token);
          setPassword("");
          return;
        }
      }
      router.replace("/app/dashboard");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      if (mfaToken && /start again/i.test((err as Error).message)) {
        setMfaToken(undefined);
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  const input = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400";
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h1 className="text-xl font-semibold">{mfaToken ? "Two-step verification" : "Sign in to FounderOS"}</h1>
        {mfaToken ? (
          <label className="block text-sm">
            Code from your authenticator app (or a recovery code)
            <input className={input} value={code} onChange={(e) => setCode(e.target.value)} autoFocus autoComplete="one-time-code" required />
          </label>
        ) : (
          <>
            <label className="block text-sm">
              Email
              <input className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="username" />
            </label>
            <label className="block text-sm">
              Password
              <input className={input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </label>
          </>
        )}
        {error && (
          <div role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}
        <button disabled={busy} className="w-full rounded-lg bg-slate-100 px-4 py-2 font-medium text-slate-900 disabled:opacity-60">
          {mfaToken ? "Verify" : "Sign in"}
        </button>
        <p className="text-xs text-slate-500">Accounts are managed by the administrator for now.</p>
      </form>
    </main>
  );
}
