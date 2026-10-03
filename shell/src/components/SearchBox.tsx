"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface Group {
  tool: string;
  toolName: string;
  hits: { id: string; title: string; snippet?: string; href: string }[];
}

/** Global search across every tool. Opens with Ctrl/Cmd+K. */
export default function SearchBox() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Group[]>([]);
  const [searchedFor, setSearchedFor] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const active = open && q.trim().length >= 2;
  useEffect(() => {
    if (!active) return;
    let live = true;
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (live && d) {
            setFound(d.results);
            setSearchedFor(q);
          }
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, active]);
  const groups = active ? found : [];
  const searched = active && searchedFor === q;

  return (
    <>
      <button onClick={() => setOpen(true)} className="flex w-full items-center justify-between rounded-lg border border-slate-700 px-3 py-1.5 text-left text-sm text-slate-400 hover:border-slate-500">
        Search
        <kbd className="rounded bg-slate-800 px-1.5 text-[10px]">Ctrl K</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-24" onClick={() => setOpen(false)} role="dialog" aria-modal="true" aria-label="Search">
          <div className="w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts, documents, tasks, SOPs, calculations…" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400" />
            <div className="mt-3 max-h-96 space-y-3 overflow-y-auto">
              {groups.map((g) => (
                <div key={g.tool}>
                  <div className="px-2 text-[11px] uppercase tracking-wide text-slate-500">{g.toolName}</div>
                  {g.hits.map((h) => (
                    <Link key={h.id} href={h.href} onClick={() => setOpen(false)} className="block rounded px-2 py-1.5 text-sm hover:bg-slate-800">
                      {h.title}
                      {h.snippet && <span className="ml-2 text-xs text-slate-500">{h.snippet}</span>}
                    </Link>
                  ))}
                </div>
              ))}
              {searched && groups.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">Nothing found.</p>}
              {!searched && <p className="px-2 py-3 text-xs text-slate-500">Type at least two letters.</p>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
