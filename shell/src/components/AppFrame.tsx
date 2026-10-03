"use client";
import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Sidebar, { type NavTool } from "./Sidebar";

/**
 * The signed-in page frame. On wide screens the sidebar sits beside the page; on phones it becomes a slide-out menu opened from a top bar.
 * `topRight` is for small always-visible controls (notification bell, feedback) the lead mounts.
 */
export default function AppFrame({ email, tools, children, topRight, isAdmin, switcher }: { email: string; tools: NavTool[]; children: ReactNode; topRight?: ReactNode; isAdmin?: boolean; switcher?: ReactNode }) {
  const path = usePathname();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === path; // opening is tied to the current page, so navigating closes the menu
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenAt(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <div className="hidden md:flex">
        <Sidebar email={email} tools={tools} isAdmin={isAdmin} switcher={switcher} />
      </div>

      {open && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <button className="absolute inset-0 bg-black/60" aria-label="Close menu" onClick={() => setOpenAt(null)} />
          <div className="absolute inset-y-0 left-0 flex max-w-[85vw]">
            <Sidebar email={email} tools={tools} isAdmin={isAdmin} switcher={switcher} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800 bg-slate-950/95 px-4 py-2 backdrop-blur md:hidden">
          <button onClick={() => setOpenAt(path)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm" aria-label="Open menu" aria-expanded={open}>
            Menu
          </button>
          <Link href="/app/dashboard" className="font-semibold">FounderOS</Link>
          <div className="flex min-w-[4.5rem] justify-end">{topRight}</div>
        </header>
        {topRight && <div className="hidden justify-end gap-2 px-6 pt-3 md:flex">{topRight}</div>}
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
