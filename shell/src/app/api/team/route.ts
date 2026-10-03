import { json } from "@/lib/team/http";
import { listInvites } from "@/lib/team/invites";
import { listMembers, seatUsage } from "@/lib/team/members";
import { can, invitableRoles } from "@/lib/team/permissions";
import { seatLimitFor, teamContext } from "@/lib/team/server";

export const dynamic = "force-dynamic";

/** The current business's team: members, pending invites (owners/admins only), seat usage, and what the caller may do. */
export async function GET() {
  const t = await teamContext();
  if (!t) return json({ error: "Not signed in or no business", code: "forbidden" }, 401);
  if (!can(t.role, "team.view")) return json({ error: "Forbidden", code: "forbidden" }, 403);
  const [members, invites, seats] = await Promise.all([
    listMembers(t.sql, t.businessId),
    can(t.role, "team.invite") ? listInvites(t.sql, t.businessId, t.session.user.id) : Promise.resolve(null),
    seatLimitFor(t.businessId).then((limit) => seatUsage(t.sql, t.businessId, limit)),
  ]);
  return json({
    businessId: t.businessId,
    you: { userId: t.session.user.id, role: t.role },
    members,
    invites: invites && invites.ok ? invites.invites : [],
    seats,
    can: { invite: invitableRoles(t.role), changeRole: can(t.role, "team.changeRole"), remove: can(t.role, "team.remove"), transfer: can(t.role, "ownership.transfer") },
  });
}
