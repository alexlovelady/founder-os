import Link from "next/link";
import { LEGAL_LINKS, NAV_LINKS } from "@/lib/site/pages";
import { NOT_A_FIRM } from "@/lib/site/config";

export default function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-slate-800 bg-slate-950 text-sm text-slate-400">
      <div className="mx-auto grid max-w-5xl gap-8 px-4 py-10 sm:grid-cols-3">
        <div>
          <p className="font-semibold text-slate-200">FounderOS</p>
          <p className="mt-2">Your back office for starting and running a business.</p>
        </div>
        <nav aria-label="Product">
          <p className="font-semibold text-slate-200">Product</p>
          <ul className="mt-2 space-y-1">
            {NAV_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="hover:text-white">{l.label}</Link>
              </li>
            ))}
            <li><Link href="/contact" className="hover:text-white">Contact</Link></li>
            <li><Link href="/login" className="hover:text-white">Sign in</Link></li>
          </ul>
        </nav>
        <nav aria-label="Legal">
          <p className="font-semibold text-slate-200">Legal</p>
          <ul className="mt-2 space-y-1">
            {LEGAL_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="hover:text-white">{l.label}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="border-t border-slate-800">
        <p className="mx-auto max-w-5xl px-4 py-5 text-xs text-slate-500">{NOT_A_FIRM}</p>
      </div>
    </footer>
  );
}
