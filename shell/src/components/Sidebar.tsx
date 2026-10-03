"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MODULES } from "@/config/modules";

const link = (active: boolean) =>
  `flex items-center justify-between rounded-lg px-3 py-2 text-sm ${active ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/60"}`;

export default function Sidebar() {
  const path = usePathname();
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-slate-800 bg-slate-900 p-3">
      <Link href="/" className="mb-4 px-3 py-2 text-lg font-semibold text-white">FounderOS</Link>
      <Link href="/app/dashboard" className={link(path === "/app/dashboard")}>Dashboard</Link>
      <div className="mt-4 px-3 text-xs uppercase tracking-wide text-slate-500">Tools</div>
      {MODULES.map((m) =>
        m.status === "live" ? (
          <Link key={m.id} href={m.route} className={link(path.startsWith(m.route))}>{m.name}</Link>
        ) : (
          <span key={m.id} className="flex items-center justify-between px-3 py-2 text-sm text-slate-500">
            {m.name}<span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px]">soon</span>
          </span>
        ),
      )}
    </aside>
  );
}
