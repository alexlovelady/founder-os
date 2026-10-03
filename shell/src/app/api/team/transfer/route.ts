import { failure, json, readBody, sameOrigin, str } from "@/lib/team/http";
import { transferOwnership } from "@/lib/team/members";
import { teamContext } from "@/lib/team/server";

export const dynamic = "force-dynamic";

/** Owner only: the chosen member becomes owner and the caller steps down to admin. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Bad origin", code: "forbidden" }, 403);
  const t = await teamContext();
  if (!t) return json({ error: "Not signed in or no business", code: "forbidden" }, 401);
  const body = await readBody(req);
  if (!body) return json({ error: "Invalid request", code: "invalid" }, 400);
  const r = await transferOwnership(t.sql, { businessId: t.businessId, actorId: t.session.user.id, targetUserId: str(body.userId) });
  return r.ok ? json({ newOwner: r.newOwner, previousOwner: r.previousOwner }) : failure(r);
}
