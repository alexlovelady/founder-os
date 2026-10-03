import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";
import { db } from "@/lib/db";
import { FeedbackInput, RateLimitError, submitFeedback } from "@/lib/platform/feedback";
import { csrfBlocked, jsonError } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

/** Signed-in users send feedback. Page path and browser string are captured; document contents never are. 10 per hour per user. */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return jsonError("Not signed in", 401);
  const blocked = csrfBlocked(req);
  if (blocked) return blocked;
  const parsed = FeedbackInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const business = await currentBusiness(session.user.id);
  try {
    const id = await submitFeedback(db(), { userId: session.user.id, businessId: business?.id ?? null }, parsed.data, req.headers.get("user-agent") ?? "");
    return Response.json({ ok: true, id }, { status: 201 });
  } catch (e) {
    if (e instanceof RateLimitError) return jsonError(e.message, 429);
    console.error("feedback failed");
    return jsonError("Something went wrong", 500);
  }
}
