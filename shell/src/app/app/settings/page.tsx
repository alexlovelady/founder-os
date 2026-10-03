import { redirect } from "next/navigation";
import BusinessForm from "@/components/BusinessForm";
import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const session = await getSession();
  if (!session) redirect("/login");
  const business = await currentBusiness(session.user.id);
  if (!business) redirect("/app/onboarding");
  return (
    <div className="mx-auto max-w-2xl space-y-8 p-8">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-5">
        <h2 className="font-medium">Your account</h2>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-slate-400">Name</dt><dd>{session.user.displayName || "Not set"}</dd>
          <dt className="text-slate-400">Email</dt><dd>{session.user.email}</dd>
          <dt className="text-slate-400">Role</dt><dd>{session.user.role}</dd>
          <dt className="text-slate-400">Your role here</dt><dd>{business.role}</dd>
        </dl>
        <p className="text-xs text-slate-500">Two-step sign-in and password changes are managed inside LegalAI → Settings for now.</p>
      </section>
      <div>
        <h2 className="mb-3 text-lg font-medium">Business profile</h2>
        <BusinessForm business={business} />
      </div>
    </div>
  );
}
