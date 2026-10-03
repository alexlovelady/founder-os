import { redirect } from "next/navigation";
import TeamManager from "@/components/team/TeamManager";
import { getSession } from "@/lib/auth/server";
import { listInvites } from "@/lib/team/invites";
import { listMembers } from "@/lib/team/members";
import { ROLE_LABEL } from "@/lib/team/permissions";
import { seatLimitFor, teamContext } from "@/lib/team/server";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const t = await teamContext();
  if (!t) redirect("/app/onboarding");
  const [members, invites, seatLimit] = await Promise.all([
    listMembers(t.sql, t.businessId),
    listInvites(t.sql, t.businessId, t.session.user.id),
    seatLimitFor(t.businessId).catch(() => null),
  ]);
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-8">
      <div>
        <h1 className="text-2xl font-semibold">Team</h1>
        <p className="mt-1 text-slate-400">People who can access this business. You are {t.role === "admin" || t.role === "owner" ? "an" : "a"} {ROLE_LABEL[t.role].toLowerCase()}.</p>
      </div>
      <TeamManager
        meId={t.session.user.id}
        meRole={t.role}
        members={members}
        invites={invites.ok ? invites.invites : []}
        seatLimit={seatLimit}
      />
    </div>
  );
}
