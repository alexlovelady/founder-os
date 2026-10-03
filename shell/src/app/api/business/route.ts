import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/server";
import { BusinessInput, createBusiness, listBusinesses, setModuleLink } from "@/lib/business";
import { provisionLegal } from "@/lib/legal";

export const dynamic = "force-dynamic";

/** Create the signed-in user's business (one per user for now) and set up its tools. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if ((await listBusinesses(session.user.id)).length > 0) return NextResponse.json({ error: "You already have a business" }, { status: 409 });
  const parsed = BusinessInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  const business = await createBusiness(session.user.id, parsed.data);
  const legal = await provisionLegal(session, business);
  if (legal) await setModuleLink(business.id, "legal", legal);
  return NextResponse.json({ id: business.id, legalLinked: Boolean(legal) }, { status: 201 });
}
