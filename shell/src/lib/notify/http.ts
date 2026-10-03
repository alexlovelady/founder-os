import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";
import { db } from "@/lib/db";

export interface Caller {
  sql: ReturnType<typeof db>;
  businessId: string;
  userId: string;
  /** From the verified session; stored only when the user saves preferences, never logged. */
  email: string | null;
}

/** The signed-in user and their business, from the session: nothing here comes from the request. */
export async function callerOr401(): Promise<{ caller: Caller } | { error: NextResponse }> {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  const business = await currentBusiness(session.user.id);
  if (!business) return { error: NextResponse.json({ error: "Set up your business first" }, { status: 409 }) };
  return { caller: { sql: db(), businessId: business.id, userId: session.user.id, email: session.user.email ?? null } };
}

/** Refuse state changes that a browser marks as coming from another site. */
export function sameSiteOnly(req: Request): NextResponse | null {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "same-site" && site !== "none") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}
