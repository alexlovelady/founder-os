"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import DeleteAccountPanel from "@/components/account/DeleteAccountPanel";

const card = "rounded-xl border border-slate-800 bg-slate-900 p-5";
const field = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400";

interface Props {
  role: string;
  businessName: string;
  initialAnalytics: boolean;
  initialNotes: string;
  /** The signed-in account's email, for the typed confirmation of account deletion. */
  accountEmail: string;
}

async function call(path: string, method: string, body?: unknown) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const d = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: r.ok, status: r.status, data: d };
}

export default function PrivacyPanel({ role, businessName, initialAnalytics, initialNotes, accountEmail }: Props) {
  const router = useRouter();
  const isOwner = role === "owner";
  const canManage = role === "owner" || role === "admin";

  const [analytics, setAnalytics] = useState(initialAnalytics);
  const [notes, setNotes] = useState(initialNotes);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string }>();
  const [saving, setSaving] = useState(false);

  const [confirm, setConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [delErr, setDelErr] = useState<string>();

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(undefined);
    const r = await call("/api/privacy/settings", "PUT", { allowProductAnalytics: analytics, aiDataUseNotes: notes }).catch(() => null);
    setSaving(false);
    if (r?.ok) setSaveMsg({ ok: true, text: "Saved." });
    else setSaveMsg({ ok: false, text: (r?.data.error as string | undefined) ?? "Could not save. Try again." });
  }

  async function del(e: FormEvent) {
    e.preventDefault();
    if (confirm.trim() !== businessName.trim() || deleting) return;
    setDeleting(true);
    setDelErr(undefined);
    const r = await call("/api/privacy/delete-business", "POST", { confirmName: confirm }).catch(() => null);
    if (r?.ok) {
      router.replace("/app/onboarding");
      router.refresh();
      return;
    }
    setDeleting(false);
    setDelErr((r?.data.error as string | undefined) ?? "Could not delete. Try again.");
  }

  return (
    <div className="space-y-6">
      <section className={card} aria-labelledby="exp-title">
        <h2 id="exp-title" className="font-medium">Download your business data</h2>
        <p className="mt-1 text-sm text-slate-400">A JSON file with your business profile, team list, privacy settings and the records in every tool. Uploaded document files are not inside it (only their details); download those from Documents. Secrets and binary data are left out.</p>
        {canManage ? (
          <a href="/api/privacy/export" download className="mt-3 inline-block rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900">Download my business data</a>
        ) : (
          <p className="mt-3 text-sm text-slate-400">Only an owner or admin can download business data.</p>
        )}
      </section>

      <form onSubmit={save} className={`${card} space-y-4`} aria-labelledby="set-title">
        <h2 id="set-title" className="font-medium">Data use</h2>
        <label className="flex items-start gap-3 text-sm text-slate-300">
          <input type="checkbox" className="mt-1" checked={!analytics} disabled={!canManage} onChange={(e) => setAnalytics(!e.target.checked)} />
          <span>Opt out of product analytics<span className="block text-xs text-slate-500">When on, FounderOS stops recording anonymous usage events for this business.</span></span>
        </label>
        <label className="block text-sm text-slate-300">Notes on how AI may use your data (optional)
          <textarea className={field} rows={3} maxLength={2000} value={notes} disabled={!canManage} onChange={(e) => setNotes(e.target.value)} placeholder="For example: do not use client names in AI answers." />
        </label>
        {canManage ? (
          <div className="flex items-center gap-3">
            <button disabled={saving} className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-60">Save</button>
            <span aria-live="polite" className={`text-sm ${saveMsg?.ok ? "text-emerald-300" : "text-red-300"}`}>{saveMsg?.text}</span>
          </div>
        ) : (
          <p className="text-xs text-slate-500">Only an owner or admin can change these.</p>
        )}
      </form>

      <section className={card} aria-labelledby="del-title">
        <h2 id="del-title" className="font-medium">Delete this business</h2>
        <div className="mt-2 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <h3 className="font-medium text-slate-200">What is deleted</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-400">
              <li>The business profile and its team memberships</li>
              <li>Everything in your tools: documents, tasks, contacts, checklists, calculations, conversations</li>
              <li>The business&apos;s audit history and notifications</li>
            </ul>
          </div>
          <div>
            <h3 className="font-medium text-slate-200">What is not deleted</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-slate-400">
              <li>Your sign-in account (deleting the business does not delete it; use &quot;Delete your account&quot; below)</li>
              <li>Data in LegalAI workspaces (deleted with your account)</li>
              <li>Database backups, which age out on the hosting provider&apos;s schedule</li>
              <li>A record that a deletion happened (no business name)</li>
            </ul>
          </div>
        </div>
        <p className="mt-3 text-sm text-amber-300">This cannot be undone. Download your data first.</p>
        {isOwner ? (
          <form onSubmit={del} className="mt-3 space-y-3">
            <label className="block text-sm text-slate-300">Type <strong className="text-slate-100">{businessName}</strong> to confirm
              <input className={field} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
            </label>
            <button disabled={deleting || confirm.trim() !== businessName.trim()} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              {deleting ? "Deleting…" : "Delete this business permanently"}
            </button>
            {delErr && <div role="alert" className="rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">{delErr}</div>}
          </form>
        ) : (
          <p className="mt-3 text-sm text-slate-400">Only the owner can delete the business.</p>
        )}
      </section>

      <DeleteAccountPanel email={accountEmail} />
    </div>
  );
}
