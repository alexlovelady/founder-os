"use client";
import { useEffect, useState } from "react";
import type { EntityRef, LinkedItem } from "./index";

interface Group {
  tool: string;
  toolName: string;
  hits: { id: string; title: string; snippet?: string }[];
}

/**
 * Drop-in "Linked items" box for any record page: shows what this record is linked to in other tools, and lets the user link more.
 * Usage: <LinkedItems tool="crm" id={contact.id} canWrite={ctx.canWrite} />
 */
export function LinkedItems({ tool, id, canWrite }: EntityRef & { canWrite: boolean }) {
  const [items, setItems] = useState<LinkedItem[]>([]);
  const [version, setVersion] = useState(0); // bump to reload
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Group[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    fetch(`/api/links?tool=${encodeURIComponent(tool)}&id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live && d) setItems(d.links); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [tool, id, version]);

  const searching = adding && q.trim().length >= 2;
  useEffect(() => {
    if (!searching) return;
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (live && d) setFound(d.results); })
        .catch(() => undefined);
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q, searching]);
  const results = searching ? found : [];

  async function link(to: EntityRef) {
    setError(undefined);
    const r = await fetch("/api/links", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: { tool, id }, to }) });
    if (!r.ok) {
      setError((await r.json().catch(() => ({}))).error ?? "Could not link");
      return;
    }
    setAdding(false);
    setQ("");
    setVersion((v) => v + 1);
  }
  async function unlink(linkId: string) {
    await fetch(`/api/links?id=${linkId}`, { method: "DELETE" });
    setVersion((v) => v + 1);
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Linked items">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Linked items</h3>
        {canWrite && <button className="text-xs underline" onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "Link something"}</button>}
      </div>
      {items.length === 0 && !adding && <p className="mt-2 text-xs text-slate-500">Nothing linked yet.</p>}
      <ul className="mt-2 space-y-1">
        {items.map((l) => (
          <li key={l.linkId} className="flex items-center justify-between text-sm">
            <a href={l.href} className="underline"><span className="text-slate-400">{l.toolName}:</span> {l.title}</a>
            {canWrite && <button className="text-xs text-slate-400 underline" onClick={() => unlink(l.linkId)}>Unlink</button>}
          </li>
        ))}
      </ul>
      {adding && (
        <div className="mt-3 space-y-2">
          <input autoFocus className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Search your contacts, documents, tasks…" value={q} onChange={(e) => setQ(e.target.value)} />
          {results.map((g) => (
            <div key={g.tool}>
              <div className="text-[11px] uppercase text-slate-500">{g.toolName}</div>
              {g.hits.map((h) => (
                <button key={h.id} className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-800" onClick={() => link({ tool: g.tool, id: h.id })}>
                  {h.title}{h.snippet && <span className="ml-2 text-xs text-slate-500">{h.snippet}</span>}
                </button>
              ))}
            </div>
          ))}
          {error && <p className="text-xs text-red-300" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
