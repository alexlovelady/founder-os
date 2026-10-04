import { NextResponse } from "next/server";
import { HttpError } from "@founderos/sdk";
import { db } from "@/lib/db";
import { consumeForUser, internalToken, parseConsumeBody, tokenMatches } from "@/lib/metering/consume";

export const dynamic = "force-dynamic";

const notFound = () => new NextResponse(null, { status: 404 });

/**
 * Private: called by LegalAI over the private network, never by browsers. 404 when INTERNAL_PROVISION_TOKEN is unset or short, 401 on a
 * wrong token (constant-time compare). Body {userId, metric: "ai_request", amount?}. The business is resolved from the user's memberships.
 */
export async function POST(req: Request) {
  const expected = internalToken();
  if (!expected) return notFound();
  if (!tokenMatches(req.headers.get("x-internal-token"), expected)) return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new HttpError(400, "Invalid body");
    }
    const r = await consumeForUser(db(), parseConsumeBody(raw));
    return NextResponse.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("quota consume failed", e instanceof Error ? e.message : "error");
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
