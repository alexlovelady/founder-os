import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/server";
import { buildContext } from "@/lib/tools/context";

export const dynamic = "force-dynamic";

/** Search across every tool at once. */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const ctx = await buildContext(session);
  if (!ctx) return NextResponse.json({ error: "Set up your business first" }, { status: 409 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 200);
  return NextResponse.json({ results: await ctx.search(q, 6) });
}
