import ResetForm from "@/components/account/ResetForm";
import { db } from "@/lib/db";
import { resetTokenValid } from "@/lib/lifecycle/reset";

export const dynamic = "force-dynamic";
export const metadata = { title: "Choose a new password | FounderOS", robots: { index: false }, referrer: "no-referrer" };

/** The link carries the token in the path. Validity is checked here without using it up; the form posts it to /api/account/reset. */
export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = await resetTokenValid(db(), token).catch(() => false);
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-10 text-slate-100">
      <ResetForm token={token} valid={valid} />
    </main>
  );
}
