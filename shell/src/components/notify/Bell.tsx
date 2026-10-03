"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

interface Item {
  id: string;
  title: string;
  body: string;
  href: string | null;
  severity: "info" | "review" | "high";
  read: boolean;
  createdAt: string;
}

const DOT = { info: "bg-slate-500", review: "bg-amber-400", high: "bg-red-500" } as const;
const POLL_MS = 60_000;

/** Notification bell with an unread badge (polls every 60 s) and a dropdown of recent items. Mount it once in the app layout. */
export default function Bell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/notifications?limit=8", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { items: Item[]; unread: number };
      setItems(j.items);
      setUnread(j.unread);
    } catch {
      /* offline: keep what we have */
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  async function read(id: string) {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, read: true } : x)));
    setUnread((n) => Math.max(0, n - 1));
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
    load();
  }

  async function readAll() {
    setItems((xs) => xs.map((x) => ({ ...x, read: true })));
    setUnread(0);
    await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true }) }).catch(() => {});
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); if (!open) load(); }}
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        className="relative rounded-lg p-2 text-slate-300 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Recent notifications" className="absolute right-0 z-50 mt-2 w-80 max-w-[90vw] rounded-xl border border-slate-700 bg-slate-900 shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && <button type="button" onClick={readAll} className="text-xs text-slate-400 underline hover:text-slate-200">Mark all read</button>}
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-slate-400">You are all caught up.</p>
          ) : (
            <ul className="max-h-96 divide-y divide-slate-800 overflow-y-auto">
              {items.map((n) => {
                const inner = (
                  <>
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? "bg-transparent ring-1 ring-slate-600" : DOT[n.severity]}`} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className={`block text-sm ${n.read ? "text-slate-400" : "font-medium text-slate-100"}`}>{n.title}</span>
                      {n.body && <span className="mt-0.5 block truncate text-xs text-slate-500">{n.body}</span>}
                    </span>
                  </>
                );
                return (
                  <li key={n.id}>
                    {n.href && n.href.startsWith("/") ? (
                      <Link href={n.href} onClick={() => { if (!n.read) read(n.id); setOpen(false); }} className="flex gap-2 px-3 py-2 hover:bg-slate-800">{inner}</Link>
                    ) : (
                      <button type="button" onClick={() => !n.read && read(n.id)} className="flex w-full gap-2 px-3 py-2 text-left hover:bg-slate-800">{inner}</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-slate-800 px-3 py-2 text-right">
            <Link href="/app/notifications" onClick={() => setOpen(false)} className="text-xs underline">See all and settings</Link>
          </div>
        </div>
      )}
    </div>
  );
}
