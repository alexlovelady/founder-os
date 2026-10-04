import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";
import { db } from "@/lib/db";
import { getPrivacySettings } from "@/lib/platform/privacy";
import PrivacyPanel from "@/components/dashboard/PrivacyPanel";

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const business = await currentBusiness(session.user.id);
  if (!business) redirect("/app/onboarding");
  const settings = await getPrivacySettings(db(), business.id);
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold">Privacy and data</h1>
        <p className="mt-1 text-slate-400">Your data belongs to {business.name}. Download it, control how it is used, or delete it. <Link href="/app/settings" className="underline">Back to settings</Link></p>
      </div>
      <PrivacyPanel role={business.role} businessName={business.name} initialAnalytics={settings.allowProductAnalytics} initialNotes={settings.aiDataUseNotes} accountEmail={session.user.email} />
    </div>
  );
}
