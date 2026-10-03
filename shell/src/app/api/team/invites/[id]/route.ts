import { failure, json, sameOrigin } from "@/lib/team/http";
import { revokeInvite } from "@/lib/team/invites";
import { teamContext } from "@/lib/team/server";

export const dynamic = "force-dynamic";

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return json({ error: "Bad origin", code: "forbidden" }, 403);
  const t = await teamContext();
  if (!t) return json({ error: "Not signed in or no business", code: "forbidden" }, 401);
  const { id } = await ctx.params;
  const r = await revokeInvite(t.sql, { businessId: t.businessId, actorId: t.session.user.id, inviteId: id });
  return r.ok ? json({ invite: r.invite }) : failure(r);
}
