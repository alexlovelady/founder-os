import { failure, json, sameOrigin } from "@/lib/team/http";
import { leaveBusiness } from "@/lib/team/members";
import { teamContext } from "@/lib/team/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Bad origin", code: "forbidden" }, 403);
  const t = await teamContext();
  if (!t) return json({ error: "Not signed in or no business", code: "forbidden" }, 401);
  const r = await leaveBusiness(t.sql, { businessId: t.businessId, userId: t.session.user.id });
  return r.ok ? json({ leftRole: r.leftRole }) : failure(r);
}
