import Link from "next/link";
import { requireAdminPage } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

const NAV = [
  ["/admin", "Overview"], ["/admin/businesses", "Businesses"], ["/admin/audit", "Audit"], ["/admin/flags", "Feature flags"],
  ["/admin/users", "Users"], ["/admin/revenue", "Revenue"], ["/admin/usage", "Usage and AI cost"], ["/admin/ai", "AI settings"],
  ["/admin/feedback", "Feedback"], ["/admin/analytics", "Analytics"], ["/admin/signup", "Signup codes"], ["/admin/compliance", "Compliance rules"],
] as const;

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage(); // anyone else gets a 404; every page repeats this check too
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-800 bg-slate-900 px-6 py-3">
        <span className="font-semibold">FounderOS admin</span>
        <nav className="flex flex-wrap gap-4 text-sm">
          {NAV.map(([href, label]) => <Link key={href} href={href} className="text-slate-300 hover:text-white">{label}</Link>)}
        </nav>
        <Link href="/app/dashboard" className="ml-auto text-sm text-slate-400 underline">Back to app</Link>
      </header>
      <main className="mx-auto max-w-6xl space-y-6 p-6">{children}</main>
    </div>
  );
}
