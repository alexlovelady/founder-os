import Link from "next/link";
import { redirect } from "next/navigation";
import InviteAccept from "@/components/team/InviteAccept";
import { getSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { previewInvite } from "@/lib/team/invites";
import { ROLE_LABEL, ROLE_SUMMARY } from "@/lib/team/permissions";

export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const session = await getSession();
  // Signed-out visitors go to sign in and come back here. (/login must honor `next`; see docs/TEAM.md.)
  if (!session) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);
  const preview = await previewInvite(db(), token, session.user);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="w-full max-w-md space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h1 className="text-xl font-semibold">Team invite</h1>
        {preview.ok ? (
          <InviteAccept token={token} businessName={preview.businessName} roleLabel={ROLE_LABEL[preview.role]} roleSummary={ROLE_SUMMARY[preview.role]} />
        ) : (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-slate-300">{preview.message}</p>
            <Link href="/app/dashboard" className="inline-block rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800">Go to your dashboard</Link>
          </div>
        )}
        <p className="text-xs text-slate-500">Signed in as {session.user.email}. Accounts are created by the FounderOS administrator for now, so an invitee needs an account before accepting.</p>
      </div>
    </main>
  );
}
