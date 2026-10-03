import Link from "next/link";
import { NAV_LINKS } from "@/lib/site/pages";

export default function SiteHeader() {
  return (
    <header className="border-b border-slate-800 bg-slate-950">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
        <Link href="/" className="text-lg font-semibold tracking-tight text-slate-100">
          FounderOS
        </Link>
        <nav aria-label="Main" className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
          {NAV_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="text-slate-300 hover:text-white">
              {l.label}
            </Link>
          ))}
          <Link href="/login" className="rounded-lg bg-slate-100 px-3 py-1.5 font-medium text-slate-900 hover:bg-white">
            Sign in
          </Link>
        </nav>
      </div>
    </header>
  );
}
