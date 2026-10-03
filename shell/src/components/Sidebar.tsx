"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import SignOut from "./SignOut";

export interface NavTool {
  id: string;
  name: string;
  group: string;
  status: "live" | "planned";
}

const GROUPS: { id: string; label: string }[] = [
  { id: "business", label: "Business" },
  { id: "legal", label: "Legal & documents" },
  { id: "money", label: "Money" },
  { id: "operations", label: "Operations" },
  { id: "growth", label: "Growth" },
];

const link = (active: boolean) =>
  `flex items-center justify-between rounded-lg px-3 py-1.5 text-sm ${active ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/60"}`;

export default function Sidebar({ email, tools }: { email: string; tools: NavTool[] }) {
  const path = usePathname();
  return (
    <aside className="flex w-60 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-slate-800 bg-slate-900 p-3">
      <Link href="/" className="mb-3 px-3 py-2 text-lg font-semibold text-white">FounderOS</Link>
      <Link href="/app/dashboard" className={link(path === "/app/dashboard")}>Dashboard</Link>
      {GROUPS.map((g) => {
        const items = tools.filter((t) => t.group === g.id);
        const showLegal = g.id === "legal";
        if (items.length === 0 && !showLegal) return null;
        return (
          <div key={g.id} className="mt-3 space-y-0.5">
            <div className="px-3 text-[11px] uppercase tracking-wide text-slate-500">{g.label}</div>
            {showLegal && <Link href="/app/legal" className={link(path.startsWith("/app/legal"))}>LegalAI</Link>}
            {items.map((t) =>
              t.status === "live" ? (
                <Link key={t.id} href={`/app/t/${t.id}`} className={link(path.startsWith(`/app/t/${t.id}`))}>{t.name}</Link>
              ) : (
                <span key={t.id} className="flex items-center justify-between px-3 py-1.5 text-sm text-slate-500">
                  {t.name}
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px]">soon</span>
                </span>
              ),
            )}
          </div>
        );
      })}
      <Link href="/app/settings" className={`${link(path === "/app/settings")} mt-4`}>Settings</Link>
      <div className="mt-auto space-y-1 px-3 py-2 text-xs text-slate-400">
        <div className="truncate">{email}</div>
        <SignOut />
      </div>
    </aside>
  );
}
