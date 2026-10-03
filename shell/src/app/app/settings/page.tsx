import Link from "next/link";
import { redirect } from "next/navigation";
import BusinessForm from "@/components/BusinessForm";
import { getPlan } from "@/config/plans";
import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";
import { db } from "@/lib/db";
import { planFor } from "@/lib/tools/plan";

export const dynamic = "force-dynamic";

const card = "rounded-xl border border-slate-800 bg-slate-900 p-4";

export default async function Settings() {
  const session = await getSession();
  if (!session) redirect("/login");
  const business = await currentBusiness(session.user.id);
  if (!business) redirect("/app/onboarding");
  const plan = await planFor(db(), business.id).then((p) => getPlan(p.id).name).catch(() => null);
  const links = [
    { href: "/app/billing", title: "Plan and billing", text: plan ? `You are on the ${plan} plan. See usage and options.` : "See your plan, usage and options." },
    { href: "/app/team", title: "Team", text: "Invite people and manage roles." },
    { href: "/app/notifications", title: "Notifications", text: "Choose what you hear about and how." },
    { href: "/app/privacy", title: "Privacy and data", text: "Download your data, control data use, or delete the business." },
  ];
  return (
    <div className="mx-auto max-w-2xl space-y-8 p-4 sm:p-8">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-medium">Your account</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-slate-400">Name</dt><dd>{session.user.displayName || "Not set"}</dd>
          <dt className="text-slate-400">Email</dt><dd className="break-all">{session.user.email}</dd>
          <dt className="text-slate-400">Role</dt><dd>{session.user.role}</dd>
          <dt className="text-slate-400">Your role here</dt><dd>{business.role}</dd>
        </dl>
        <p className="text-xs text-slate-500">Two-step sign-in and password changes are managed inside LegalAI → Settings for now.</p>
      </section>
      <nav aria-label="More settings" className="grid gap-3 sm:grid-cols-2">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className={`${card} block hover:border-slate-600`}>
            <div className="text-sm font-medium">{l.title}</div>
            <div className="mt-1 text-xs text-slate-400">{l.text}</div>
          </Link>
        ))}
      </nav>
      <div>
        <h2 className="mb-3 text-lg font-medium">Business profile</h2>
        <BusinessForm business={business} />
      </div>
    </div>
  );
}
