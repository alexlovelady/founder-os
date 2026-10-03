import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { ACTIVE_BUSINESS_COOKIE } from "@/lib/team/active";
import { json, readBody, sameOrigin, str } from "@/lib/team/http";
import { acceptInvite, inviteBusinessId } from "@/lib/team/invites";
import { seatLimitFor } from "@/lib/team/server";

export const dynamic = "force-dynamic";

/** Accept an invite as the signed-in user. The new business becomes their active one. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Bad origin", code: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return json({ error: "Sign in first", code: "forbidden" }, 401);
  const body = await readBody(req);
  const token = str(body?.token);
  const sql = db();
  // The seat limit depends on the plan of the business the token belongs to.
  const businessId = await inviteBusinessId(sql, token);
  const seatLimit = businessId ? await seatLimitFor(businessId) : null;
  const r = await acceptInvite(sql, { token, user: session.user, seatLimit });
  if (!r.ok) return json({ error: r.message, code: r.problem }, r.problem === "not_found" ? 404 : 409);
  const jar = await cookies();
  jar.set(ACTIVE_BUSINESS_COOKIE, r.businessId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return json({ businessId: r.businessId, businessName: r.businessName, role: r.role });
}
