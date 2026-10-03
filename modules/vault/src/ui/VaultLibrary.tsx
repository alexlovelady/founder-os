"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { CATEGORIES } from "../facts";
import { ACCEPT, BASE, ExpiryBadge, formatSize, NOTE, readError, Snippet, type DocDto } from "./shared";

export default function VaultLibrary({ initial, canWrite }: { initial: DocDto[]; canWrite: boolean }) {
  const [docs, setDocs] = useState(initial);
  const [counts, setCounts] = useState<Record<string, number>>(() => {
    const c: Record<string, number> = {};
    for (const d of initial) c[d.category] = (c[d.category] ?? 0) + 1;
    return c;
  });
  const [category, setCategory] = useState<string>("");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [expiring, setExpiring] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [meta, setMeta] = useState({ category: "Other", docType: "", tags: "", expirationDate: "" });
  const fileInput = useRef<HTMLInputElement>(null);
  const first = useRef(true);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (category) p.set("category", category);
    if (status) p.set("status", status);
    if (q.trim()) p.set("q", q.trim());
    if (expiring) p.set("expiring", "1");
    const r = await fetch(`${BASE}/documents?${p}`);
    if (!r.ok) { setError(await readError(r)); return; }
    const d = await r.json();
    setDocs(d.documents);
    setCounts(Object.fromEntries(d.categories.map((c: { category: string; count: number }) => [c.category, c.count])));
  }, [category, status, q, expiring]);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load]);

  async function upload(files: FileList | File[]) {
    setError(undefined); setMessage(undefined);
    setUploading(true);
    let ok = 0;
    for (const f of Array.from(files)) {
      const fd = new FormData();
      fd.set("file", f);
      fd.set("category", category || meta.category);
      if (meta.docType) fd.set("docType", meta.docType);
      if (meta.tags) fd.set("tags", meta.tags);
      if (meta.expirationDate) fd.set("expirationDate", meta.expirationDate);
      const r = await fetch(`${BASE}/documents`, { method: "POST", body: fd });
      if (!r.ok) { setError(`${f.name}: ${await readError(r)}`); break; }
      ok++;
    }
    setUploading(false);
    if (ok) setMessage(`Uploaded ${ok} file${ok === 1 ? "" : "s"}.`);
    if (fileInput.current) fileInput.current.value = "";
    await load();
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 text-slate-100">
      <header>
        <h1 className="text-xl font-semibold">Document vault</h1>
        <p className="text-sm text-slate-400">{NOTE}</p>
      </header>

      {canWrite && (
        <section aria-label="Upload" className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
            className={`flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center text-sm ${dragging ? "border-sky-400 bg-sky-500/10" : "border-slate-700"}`}
          >
            <p className="text-slate-300">{uploading ? "Uploading…" : "Drop files here, or"}</p>
            <button type="button" disabled={uploading} onClick={() => fileInput.current?.click()} className="mt-2 rounded-lg bg-sky-600 px-4 py-2 font-medium disabled:opacity-50">Choose files</button>
            <input ref={fileInput} type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Choose files to upload" onChange={(e) => e.target.files && void upload(e.target.files)} />
            <p className="mt-2 text-xs text-slate-500">PDF, Word, Excel, CSV, text, Markdown, PNG, JPG, WebP. Up to 15 MB each.</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <label className="text-xs text-slate-400">Category{category && " (from sidebar)"}
              <select disabled={!!category} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" value={category || meta.category} onChange={(e) => setMeta({ ...meta, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </label>
            <label className="text-xs text-slate-400">Type (optional)
              <input className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" placeholder="e.g. operating agreement" value={meta.docType} maxLength={100} onChange={(e) => setMeta({ ...meta, docType: e.target.value })} />
            </label>
            <label className="text-xs text-slate-400">Tags (comma separated)
              <input className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" value={meta.tags} onChange={(e) => setMeta({ ...meta, tags: e.target.value })} />
            </label>
            <label className="text-xs text-slate-400">Expires (optional)
              <input type="date" className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100" value={meta.expirationDate} onChange={(e) => setMeta({ ...meta, expirationDate: e.target.value })} />
            </label>
          </div>
        </section>
      )}
      {error && <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">{error}</p>}
      {message && <p role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2 text-sm text-emerald-300">{message}</p>}

      <div className="flex flex-col gap-4 md:flex-row">
        <nav aria-label="Categories" className="md:w-48 md:shrink-0">
          <ul className="flex flex-wrap gap-1 md:block md:space-y-1">
            {[{ key: "", label: "All documents", n: total }, ...CATEGORIES.map((c) => ({ key: c as string, label: c as string, n: counts[c] ?? 0 }))].map((c) => (
              <li key={c.key}>
                <button type="button" aria-current={category === c.key} onClick={() => setCategory(c.key)} className={`flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-sm ${category === c.key ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-900"}`}>
                  <span>{c.label}</span><span className="text-xs text-slate-500">{c.n}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <section className="min-w-0 flex-1 space-y-3" aria-label="Documents">
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="vault-search">Search documents</label>
            <input id="vault-search" type="search" className="min-w-0 flex-1 basis-48 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Search names, tags and the text inside files" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="sr-only" htmlFor="vault-status">Status</label>
            <select id="vault-status" className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Not archived</option><option value="active">Active</option><option value="draft">Draft</option><option value="review">In review</option><option value="archived">Archived</option><option value="all">Everything</option>
            </select>
            <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={expiring} onChange={(e) => setExpiring(e.target.checked)} /> Expiring soon</label>
          </div>

          {docs.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">No documents match. {canWrite ? "Drop a file above to add one." : ""}</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-900 text-xs uppercase text-slate-400">
                  <tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Expires</th><th className="px-3 py-2">Ver.</th><th className="px-3 py-2">Size</th><th className="px-3 py-2">Updated</th></tr>
                </thead>
                <tbody>
                  {docs.map((d) => (
                    <tr key={d.id} className="border-t border-slate-800">
                      <td className="px-3 py-2">
                        <a href={`/app/t/vault/d/${d.id}`} className="font-medium underline">{d.name}</a>
                        <div className="text-xs text-slate-500">{[d.docType, d.status !== "active" ? d.status : "", ...d.tags.map((t) => `#${t}`)].filter(Boolean).join(" · ")}</div>
                        {d.snippet && <p className="mt-1 text-xs text-slate-400" aria-label="Matching text from the file"><Snippet html={d.snippet} /></p>}
                      </td>
                      <td className="px-3 py-2 text-slate-300">{d.category}</td>
                      <td className="px-3 py-2"><ExpiryBadge date={d.expirationDate} daysLeft={d.daysLeft} /></td>
                      <td className="px-3 py-2 text-slate-400">v{d.version}</td>
                      <td className="px-3 py-2 text-slate-400">{formatSize(d.size)}</td>
                      <td className="px-3 py-2 text-slate-400">{d.updatedAt.slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
