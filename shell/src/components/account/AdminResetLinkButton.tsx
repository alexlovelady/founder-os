"use client";
import { useState } from "react";
import { postJson } from "./shared";

/** Platform admin only (the page and the API both check). The link is shown once and never stored; copy it and give it to the person yourself. */
export default function AdminResetLinkButton({ userId, self }: { userId: string; self: boolean }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string }>();
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  if (self) return null;

  async function create() {
    if (!window.confirm("Create a password reset link for this user? Anyone who holds the link can set their password (two-step verification, if they use it, still applies). It works once and expires in 24 hours.")) return;
    setBusy(true);
    setMsg("");
    const r = await postJson("/api/account/admin-reset-link", { userId });
    setBusy(false);
    if (r.ok && typeof r.data.path === "string") setLink({ url: `${window.location.origin}${r.data.path}`, expiresAt: String(r.data.expiresAt ?? "") });
    else setMsg(String(r.data.error ?? "Could not create the link"));
  }

  if (link) {
    return (
      <div className="mt-1 space-y-1">
        <input readOnly aria-label="Reset link" value={link.url} onFocus={(e) => e.currentTarget.select()} className="w-64 rounded border border-slate-700 bg-slate-950 p-1 font-mono text-xs text-slate-100" />
        <div className="flex gap-2 text-xs">
          <button type="button" className="underline" onClick={() => void navigator.clipboard?.writeText(link.url).then(() => setMsg("Copied"))}>Copy</button>
          <button type="button" className="text-slate-400 underline" onClick={() => { setLink(undefined); setMsg(""); }}>Hide</button>
        </div>
        <p className="text-xs text-amber-400">Shown once. Expires {link.expiresAt.slice(0, 16).replace("T", " ")} UTC.</p>
        <span role="status" className="text-xs text-slate-400">{msg}</span>
      </div>
    );
  }
  return (
    <div className="mt-1">
      <button type="button" disabled={busy} onClick={() => void create()} className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50">Create reset link</button>
      <span role="alert" className="ml-2 text-xs text-amber-400">{msg}</span>
    </div>
  );
}
