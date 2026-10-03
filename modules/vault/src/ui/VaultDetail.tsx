"use client";
import { useRef, useState } from "react";
import { LinkedItems } from "@founderos/sdk/ui";
import { CATEGORIES } from "../facts";
import { ACCEPT, BASE, ExpiryBadge, formatSize, NOTE, readError, type DocDto, type VersionDto } from "./shared";

export default function VaultDetail({ initial, canWrite }: { initial: { document: DocDto; versions: VersionDto[] }; canWrite: boolean }) {
  const [doc, setDoc] = useState(initial.document);
  const [versions, setVersions] = useState(initial.versions);
  const [name, setName] = useState(doc.name);
  const [tags, setTags] = useState(doc.tags.join(", "));
  const [docType, setDocType] = useState(doc.docType);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function patch(body: Record<string, unknown>) {
    setError(undefined); setMessage(undefined);
    const r = await fetch(`${BASE}/documents/${doc.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { setError(await readError(r)); return; }
    const d = (await r.json()).document as DocDto;
    setDoc(d); setName(d.name); setTags(d.tags.join(", ")); setDocType(d.docType);
    setMessage("Saved.");
  }

  async function newVersion(file: File) {
    setError(undefined); setMessage(undefined); setBusy(true);
    const fd = new FormData();
    fd.set("file", file);
    const r = await fetch(`${BASE}/documents/${doc.id}/versions`, { method: "POST", body: fd });
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
    if (!r.ok) { setError(await readError(r)); return; }
    const d = await r.json();
    setDoc(d.document); setVersions(d.versions);
    setMessage(`Version ${d.document.version} added. Earlier versions are kept.`);
  }

  async function remove() {
    if (!window.confirm(`Permanently delete "${doc.name}" and all its versions? This cannot be undone.`)) return;
    const r = await fetch(`${BASE}/documents/${doc.id}`, { method: "DELETE" });
    if (!r.ok) { setError(await readError(r)); return; }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload so the list is fresh
    window.location.href = "/app/t/vault";
  }

  // Other tools publish their tasks API to the browser; if it is not there the button just reports that.
  async function addReminder() {
    setError(undefined); setMessage(undefined);
    const r = await fetch("/api/tools/tasks/from-source", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Renew or review: ${doc.name}`, dueDate: doc.expirationDate, priority: "medium", source: "document", sourceRef: { tool: "vault", id: doc.id } }),
    });
    setMessage(r.ok ? "Reminder added to Tasks." : "Could not add a reminder (is the Tasks tool available?).");
  }

  const dirty = name.trim() !== doc.name || docType.trim() !== doc.docType || tags !== doc.tags.join(", ");

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 text-slate-100">
      <a href="/app/t/vault" className="text-sm text-slate-400 underline">&larr; All documents</a>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold">{doc.name}</h1>
          <p className="text-sm text-slate-400">{doc.originalFilename} · {formatSize(doc.size)} · version {doc.version}</p>
        </div>
        <div className="flex items-center gap-3">
          <ExpiryBadge date={doc.expirationDate} daysLeft={doc.daysLeft} />
          <a href={`${BASE}/documents/${doc.id}/download`} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium">Download</a>
        </div>
      </header>
      <p className="text-xs text-slate-500">{NOTE}</p>
      {error && <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">{error}</p>}
      {message && <p role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2 text-sm text-emerald-300">{message}</p>}

      <section aria-label="Details" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-slate-400">Name
            <input disabled={!canWrite} maxLength={200} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-xs text-slate-400">Category
            <select disabled={!canWrite} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" value={doc.category} onChange={(e) => void patch({ category: e.target.value })}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-400">Type
            <input disabled={!canWrite} maxLength={100} placeholder="e.g. insurance policy" className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" value={docType} onChange={(e) => setDocType(e.target.value)} />
          </label>
          <label className="text-xs text-slate-400">Tags (comma separated)
            <input disabled={!canWrite} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
          <label className="text-xs text-slate-400">Status
            <select disabled={!canWrite} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" value={doc.status} onChange={(e) => void patch({ status: e.target.value })}>
              <option value="active">Active</option><option value="draft">Draft</option><option value="review">In review</option><option value="archived">Archived</option>
            </select>
          </label>
          <label className="text-xs text-slate-400">Expiration date
            <input type="date" disabled={!canWrite} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" value={doc.expirationDate ?? ""} onChange={(e) => void patch({ expirationDate: e.target.value || null })} />
          </label>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-3">
            <button type="button" disabled={!dirty || !name.trim()} onClick={() => void patch({ name, docType, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) })} className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium disabled:opacity-50">Save changes</button>
            {doc.expirationDate && <button type="button" onClick={() => void addReminder()} className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm">Add a reminder task</button>}
          </div>
        )}
      </section>

      <section aria-label="Version history" className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">Version history</h2>
          {canWrite && (
            <>
              <button type="button" disabled={busy} onClick={() => fileInput.current?.click()} className="text-xs underline">{busy ? "Uploading…" : "Upload a new version"}</button>
              <input ref={fileInput} type="file" accept={ACCEPT} className="sr-only" aria-label="Choose the new version file" onChange={(e) => e.target.files?.[0] && void newVersion(e.target.files[0])} />
            </>
          )}
        </div>
        <ul className="divide-y divide-slate-800 text-sm">
          {versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>v{v.version}{v.isCurrent && <span className="ml-2 rounded-full border border-emerald-500/40 px-2 text-xs text-emerald-300">current</span>} <span className="text-slate-400">{v.originalFilename} · {formatSize(v.size)} · {v.createdAt.slice(0, 10)}</span></span>
              <a className="text-xs underline" href={`${BASE}/documents/${doc.id}/download?version=${v.version}`}>Download</a>
            </li>
          ))}
        </ul>
      </section>

      <LinkedItems tool="vault" id={doc.id} canWrite={canWrite} />

      {canWrite && <button type="button" onClick={() => void remove()} className="text-xs text-red-300 underline">Delete this document</button>}
    </div>
  );
}
