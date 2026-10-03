import { cookies } from "next/headers";
import { getSession } from "@/lib/auth/server";
import { db } from "@/lib/db";
import { ACTIVE_BUSINESS_COOKIE } from "@/lib/team/active";
import { json, readBody, sameOrigin, str } from "@/lib/team/http";
import { getMembership } from "@/lib/team/members";

export const dynamic = "force-dynamic";

/** Business switcher: remember the active business, only if the signed-in user is a member of it. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return json({ error: "Bad origin", code: "forbidden" }, 403);
  const session = await getSession();
  if (!session) return json({ error: "Not signed in", code: "forbidden" }, 401);
  const body = await readBody(req);
  const businessId = str(body?.businessId);
  if (!/^[0-9a-f-]{36}$/i.test(businessId) || !(await getMembership(db(), businessId, session.user.id))) return json({ error: "Business not found", code: "not_found" }, 404);
  const jar = await cookies();
  jar.set(ACTIVE_BUSINESS_COOKIE, businessId, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return json({ businessId });
}
