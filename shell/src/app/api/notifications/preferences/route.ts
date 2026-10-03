import { NextResponse } from "next/server";
import { PreferencesInput, getPreferences, setPreferences } from "@/lib/notify";
import { callerOr401, sameSiteOnly } from "@/lib/notify/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const r = await callerOr401();
  if ("error" in r) return r.error;
  return NextResponse.json(await getPreferences(r.caller.sql, r.caller.businessId, r.caller.userId));
}

/** PUT /api/notifications/preferences. The email address comes from the session, not the body. */
export async function PUT(req: Request) {
  const blocked = sameSiteOnly(req);
  if (blocked) return blocked;
  const r = await callerOr401();
  if ("error" in r) return r.error;
  const body = PreferencesInput.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  return NextResponse.json(await setPreferences(r.caller.sql, r.caller.businessId, r.caller.userId, body.data, r.caller.email));
}
