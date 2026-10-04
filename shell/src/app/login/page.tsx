"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
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
  const [canSignUp, setCanSignUp] = useState(false);
  const [created, setCreated] = useState(false);
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const wasCreated = q.get("created") === "1";
    const note = q.get("reset") === "1" ? "Password changed. Sign in with your new password."
      : q.get("verified") === "1" ? "Email confirmed. Sign in to continue."
      : q.get("deleted") === "1" ? "Your account has been deleted." : undefined;
    fetch("/api/signup/status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { mode?: string; available?: boolean } | null) => {
        setCreated(wasCreated);
        setNotice(note);
        setCanSignUp(Boolean(d && d.mode !== "closed" && d.available));
      })
      .catch(() => {
        setCreated(wasCreated);
        setNotice(note);
      });
  }, []);

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
      // Honor ?next=/some/path (e.g. an invite link) but only same-site paths: a single leading slash, never //host or a backslash.
      const next = new URLSearchParams(window.location.search).get("next") ?? "";
      const sameSite = next.startsWith("/") && !next.startsWith("//") && !next.includes("\\");
      router.replace(sameSite ? next : "/app/dashboard");
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
        {created && !error && (
          <div role="status" className="rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-200">
            Account created. Sign in with your new email and password.
          </div>
        )}
        {notice && !error && (
          <div role="status" className="rounded-lg bg-emerald-950 px-3 py-2 text-sm text-emerald-200">
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}
        <button disabled={busy} className="w-full rounded-lg bg-slate-100 px-4 py-2 font-medium text-slate-900 disabled:opacity-60">
          {mfaToken ? "Verify" : "Sign in"}
        </button>
        {!mfaToken && (
          <p className="text-sm text-slate-400">
            <Link href="/forgot" className="underline">Forgot password?</Link>
          </p>
        )}
        {canSignUp && !mfaToken && (
          <p className="text-sm text-slate-400">
            New here? <Link href="/signup" className="underline">Create an account</Link>
          </p>
        )}
      </form>
    </main>
  );
}
