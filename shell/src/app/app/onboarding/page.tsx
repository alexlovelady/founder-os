import { redirect } from "next/navigation";
import BusinessForm from "@/components/BusinessForm";
import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";

export const dynamic = "force-dynamic";

export default async function Onboarding() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (await currentBusiness(session.user.id)) redirect("/app/dashboard");
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Set up your business</h1>
        <p className="mt-1 text-slate-400">A few questions so FounderOS can tailor your checklist and fill in your documents. You can change any of this later.</p>
      </div>
      <BusinessForm />
    </div>
  );
}
