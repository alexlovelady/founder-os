"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ListItem {
  id: string;
  title: string;
  body: string;
  href: string | null;
  severity: "info" | "review" | "high";
  read: boolean;
  createdAt: string;
}

const BADGE = { info: "bg-slate-700 text-slate-200", review: "bg-amber-900 text-amber-200", high: "bg-red-900 text-red-200" } as const;

async function post(body: unknown) {
  await fetch("/api/notifications/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

export default function NotificationList({ items }: { items: ListItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const unread = items.filter((i) => !i.read).length;

  async function run(body: unknown) {
    setBusy(true);
    try { await post(body); router.refresh(); } finally { setBusy(false); }
  }

  if (items.length === 0) return <p className="text-sm text-slate-400">No notifications yet. Deadlines, expiring documents and your weekly brief will show up here.</p>;
  return (
    <div>
      {unread > 0 && (
        <button type="button" disabled={busy} onClick={() => run({ all: true })} className="mb-3 text-xs text-slate-400 underline hover:text-slate-200 disabled:opacity-50">
          Mark all {unread} as read
        </button>
      )}
      <ul className="space-y-2">
        {items.map((n) => (
          <li key={n.id} className={`rounded-lg p-3 ${n.read ? "bg-slate-950/60" : "bg-slate-950 ring-1 ring-slate-700"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${BADGE[n.severity]}`}>{n.severity}</span>
                  <span className={`text-sm ${n.read ? "text-slate-400" : "font-medium"}`}>{n.title}</span>
                </div>
                {n.body && <p className="mt-1 text-xs text-slate-400">{n.body}</p>}
                <p className="mt-1 text-[11px] text-slate-500">{new Date(n.createdAt).toLocaleString()}</p>
              </div>
              <div className="flex shrink-0 gap-3 text-xs">
                {n.href && n.href.startsWith("/") && <Link href={n.href} className="underline">Open</Link>}
                {!n.read && <button type="button" disabled={busy} onClick={() => run({ id: n.id })} className="text-slate-400 underline hover:text-slate-200 disabled:opacity-50">Mark read</button>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
