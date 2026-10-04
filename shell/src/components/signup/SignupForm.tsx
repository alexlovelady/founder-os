"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { MIN_PASSWORD, passwordHint } from "@/lib/signup/password";

const input = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400";
const HINT_COLOR = { short: "text-red-300", weak: "text-amber-300", ok: "text-slate-300", strong: "text-emerald-300" } as const;

export default function SignupForm({ needsCode }: { needsCode: boolean }) {
  const router = useRouter();
  const [f, setF] = useState({ email: "", displayName: "", password: "", confirm: "", code: "", acceptTerms: false });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const hint = passwordHint(f.password);
  const mismatch = f.confirm.length > 0 && f.confirm !== f.password;
  const set = (k: keyof typeof f) => (e: { target: { value: string; checked?: boolean } }) => setF({ ...f, [k]: k === "acceptTerms" ? Boolean(e.target.checked) : e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (f.password !== f.confirm) return setError("The two passwords do not match.");
    setBusy(true);
    try {
      const r = await fetch("/api/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: f.email, displayName: f.displayName, password: f.password, code: needsCode ? f.code : undefined, acceptTerms: f.acceptTerms }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; next?: string };
      if (!r.ok) return setError(d.error ?? "Could not create the account.");
      router.replace(d.next && d.next.startsWith("/") && !d.next.startsWith("//") ? d.next : "/login?created=1");
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6" noValidate={false}>
      <h1 className="text-xl font-semibold">Create your FounderOS account</h1>
      <label className="block text-sm">
        Your name
        <input className={input} value={f.displayName} onChange={set("displayName")} required maxLength={200} autoComplete="name" autoFocus />
      </label>
      <label className="block text-sm">
        Email
        <input className={input} type="email" value={f.email} onChange={set("email")} required autoComplete="username" />
      </label>
      <label className="block text-sm">
        Password
        <input className={input} type="password" value={f.password} onChange={set("password")} required minLength={MIN_PASSWORD} maxLength={256} autoComplete="new-password" aria-describedby="pw-hint" />
        <span id="pw-hint" aria-live="polite" className={`mt-1 block text-xs ${f.password ? HINT_COLOR[hint.level] : "text-slate-500"}`}>
          {f.password ? hint.message : `At least ${MIN_PASSWORD} characters. A passphrase of several words is easiest to remember.`}
        </span>
      </label>
      <label className="block text-sm">
        Confirm password
        <input className={input} type="password" value={f.confirm} onChange={set("confirm")} required autoComplete="new-password" aria-invalid={mismatch} aria-describedby={mismatch ? "pw-mismatch" : undefined} />
        {mismatch && <span id="pw-mismatch" className="mt-1 block text-xs text-red-300">The passwords do not match yet.</span>}
      </label>
      {needsCode && (
        <label className="block text-sm">
          Invite code
          <input className={`${input} font-mono`} value={f.code} onChange={set("code")} required maxLength={100} autoComplete="off" spellCheck={false} placeholder="FOS-XXXXX-XXXXX-XXXXX-XXXXX" />
        </label>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={f.acceptTerms} onChange={set("acceptTerms")} required />
        <span>
          I accept the <Link href="/terms" target="_blank" className="underline">Terms</Link> and have read the <Link href="/privacy" target="_blank" className="underline">Privacy notice</Link>.
          <span className="block text-xs text-slate-500">Both are drafts that are still waiting for professional legal review.</span>
        </span>
      </label>
      {error && (
        <div role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}
      <button disabled={busy} className="w-full rounded-lg bg-slate-100 px-4 py-2 font-medium text-slate-900 disabled:opacity-60">
        {busy ? "Creating..." : "Create account"}
      </button>
      <p className="text-xs text-slate-500">
        {needsCode ? "" : "We will email you a link to confirm your address before you can sign in. "}Already have an account?{" "}
        <Link href="/login" className="underline">Sign in</Link>
      </p>
    </form>
  );
}
