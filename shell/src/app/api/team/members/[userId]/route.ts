import { failure, json, readBody, sameOrigin, str } from "@/lib/team/http";
import { changeRole, removeMember } from "@/lib/team/members";
import { teamContext } from "@/lib/team/server";

export const dynamic = "force-dynamic";

/** Change a member's role. The target must be a member of the caller's active business; the actor's role is re-read inside the transaction. */
export async function PATCH(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  if (!sameOrigin(req)) return json({ error: "Bad origin", code: "forbidden" }, 403);
  const t = await teamContext();
  if (!t) return json({ error: "Not signed in or no business", code: "forbidden" }, 401);
  const { userId } = await ctx.params;
  const body = await readBody(req);
  if (!body) return json({ error: "Invalid request", code: "invalid" }, 400);
  const r = await changeRole(t.sql, { businessId: t.businessId, actorId: t.session.user.id, targetUserId: decodeURIComponent(userId), newRole: str(body.role) });
  return r.ok ? json({ from: r.from, to: r.to }) : failure(r);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ userId: string }> }) {
  if (!sameOrigin(req)) return json({ error: "Bad origin", code: "forbidden" }, 403);
  const t = await teamContext();
  if (!t) return json({ error: "Not signed in or no business", code: "forbidden" }, 401);
  const { userId } = await ctx.params;
  const r = await removeMember(t.sql, { businessId: t.businessId, actorId: t.session.user.id, targetUserId: decodeURIComponent(userId) });
  return r.ok ? json({ removedRole: r.removedRole }) : failure(r);
}
