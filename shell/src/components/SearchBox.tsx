"use client";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { filterCommands, isCommandQuery, moveIndex } from "@/lib/dashboard/logic";

interface Group {
  tool: string;
  toolName: string;
  hits: { id: string; title: string; snippet?: string; href: string }[];
}

interface Row { key: string; title: string; note?: string; href: string; group: string }

/** Global search and command palette across every tool. Opens with Ctrl/Cmd+K. An empty box or ">" lists commands. */
export default function SearchBox() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Group[]>([]);
  const [searchedFor, setSearchedFor] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
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

  const commandMode = isCommandQuery(q);
  const active2 = open && !commandMode && q.trim().length >= 2;
  useEffect(() => {
    if (!active2) return;
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
  }, [q, active2]);

  const searched = active2 && searchedFor === q;
  const rows: Row[] = commandMode
    ? filterCommands(q).map((c) => ({ key: `cmd-${c.id}`, title: c.title, note: c.hint, href: c.href, group: "Commands" }))
    : active2
      ? found.flatMap((g) => g.hits.map((h) => ({ key: `${g.tool}-${h.id}`, title: h.title, note: h.snippet, href: h.href, group: g.toolName })))
      : [];
  const current = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);

  function close() {
    setOpen(false);
    setQ("");
    setActive(0);
  }

  function onInputKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(moveIndex(current, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Home" && rows.length) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && rows.length) {
      e.preventDefault();
      setActive(rows.length - 1);
    } else if (e.key === "Enter" && current >= 0) {
      e.preventDefault();
      const href = rows[current].href;
      close();
      router.push(href);
    }
  }

  const listId = "search-results";
  return (
    <>
      <button onClick={() => setOpen(true)} className="flex w-full items-center justify-between rounded-lg border border-slate-700 px-3 py-1.5 text-left text-sm text-slate-400 hover:border-slate-500" aria-label="Search or run a command (Ctrl K)">
        Search
        <kbd className="rounded bg-slate-800 px-1.5 text-[10px]">Ctrl K</kbd>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-24" onClick={close} role="dialog" aria-modal="true" aria-label="Search and commands">
          <div className="w-full max-w-xl rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <input
              ref={input}
              value={q}
              onChange={(e) => { setQ(e.target.value); setActive(0); }}
              onKeyDown={onInputKey}
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={current >= 0 ? `${listId}-${current}` : undefined}
              aria-label="Search, or type > for commands"
              placeholder="Search contacts, documents, tasks… or run a command"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400"
            />
            <ul id={listId} role="listbox" aria-label={commandMode ? "Commands" : "Search results"} className="mt-3 max-h-96 overflow-y-auto">
              {rows.map((r, i) => (
                <li key={r.key} role="presentation">
                  {(i === 0 || rows[i - 1].group !== r.group) && <div role="presentation" className="px-2 pt-2 text-[11px] uppercase tracking-wide text-slate-500">{r.group}</div>}
                  <Link
                    id={`${listId}-${i}`} role="option" aria-selected={i === current} tabIndex={-1} href={r.href} onClick={close} onMouseMove={() => setActive(i)}
                    className={`block rounded px-2 py-1.5 text-sm ${i === current ? "bg-slate-800" : "hover:bg-slate-800"}`}
                  >
                    {r.title}
                    {r.note && <span className="ml-2 text-xs text-slate-500">{r.note}</span>}
                  </Link>
                </li>
              ))}
            </ul>
            <div aria-live="polite">
              {commandMode && rows.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">No matching command.</p>}
              {searched && rows.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">Nothing found.</p>}
              {!commandMode && !searched && <p className="px-2 py-3 text-xs text-slate-500">Type at least two letters.</p>}
            </div>
            <p className="px-2 pt-1 text-[11px] text-slate-600">Up and down to move, Enter to open, Esc to close. Type &gt; to list commands.</p>
          </div>
        </div>
      )}
    </>
  );
}
