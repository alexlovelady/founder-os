import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";
import { db } from "@/lib/db";
import { EventInput, trackEvent } from "@/lib/platform/events";
import { csrfBlocked, jsonError } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

/** Browser-reported product events: allow-listed names only, small sanitized props, honors the business's analytics opt-out. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return jsonError("Not signed in", 401);
  const blocked = csrfBlocked(req);
  if (blocked) return blocked;
  const parsed = EventInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Unknown event", 400);
  const business = await currentBusiness(session.user.id);
  const stored = await trackEvent(db(), { businessId: business?.id ?? null, userId: session.user.id, name: parsed.data.name, props: parsed.data.props });
  return Response.json({ ok: true, stored });
}
