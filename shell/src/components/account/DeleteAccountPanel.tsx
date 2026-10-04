"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { inputCls, postJson } from "./shared";

const card = "rounded-xl border border-slate-800 bg-slate-900 p-5";

/** The real account deletion flow on the privacy page. Typed email plus current password; the server enforces every rule again. */
export default function DeleteAccountPanel({ email }: { email: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ready = typed.trim().toLowerCase() === email.trim().toLowerCase() && password.length > 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(undefined);
    const r = await postJson("/api/account/delete", { confirmEmail: typed, password });
    setBusy(false);
    setPassword("");
    if (r.ok) {
      router.replace("/login?deleted=1");
      router.refresh();
    } else setError(String(r.data.error ?? "Could not delete the account."));
  }

  return (
    <section className={card} aria-labelledby="acct-title">
      <h2 id="acct-title" className="font-medium">Delete your account</h2>
      <div className="mt-2 grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <h3 className="font-medium text-slate-200">What is deleted</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-400">
            <li>Your sign-in account: the email address is replaced, you are signed out everywhere, two-step verification is removed</li>
            <li>Every business where you are the only member, with all its data</li>
            <li>Your membership in businesses you share with others (they keep their data)</li>
            <li>Your LegalAI matters that nobody else belongs to, with their uploaded files, text and search data</li>
          </ul>
        </div>
        <div>
          <h3 className="font-medium text-slate-200">What is not deleted</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-400">
            <li>Anything shared with other people (shared matters and businesses)</li>
            <li>Audit log entries, which keep only an anonymous user id</li>
            <li>Database backups, until they rotate out</li>
          </ul>
        </div>
      </div>
      <p className="mt-3 text-sm text-amber-300">This cannot be undone. If you are the only owner of a business with other members, transfer ownership first. Download your data first.</p>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="mt-3 rounded-lg border border-red-800 px-4 py-2 text-sm text-red-200 hover:bg-red-950">Delete my account...</button>
      ) : (
        <form onSubmit={submit} className="mt-3 space-y-3">
          <label className="block text-sm text-slate-300">Type your email address <strong className="text-slate-100">{email}</strong> to confirm
            <input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <label className="block text-sm text-slate-300">Current password
            <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <div className="flex items-center gap-3">
            <button disabled={!ready || busy} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "Deleting..." : "Delete my account permanently"}</button>
            <button type="button" className="text-sm text-slate-400 underline" onClick={() => { setOpen(false); setPassword(""); setError(undefined); }}>Cancel</button>
          </div>
          {error && <div role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">{error}</div>}
        </form>
      )}
    </section>
  );
}
