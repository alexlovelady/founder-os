import { NextResponse } from "next/server";
import { z } from "zod";
import { markAllRead, markRead } from "@/lib/notify";
import { callerOr401, sameSiteOnly } from "@/lib/notify/http";

export const dynamic = "force-dynamic";

const Body = z.union([z.object({ id: z.string().min(1).max(64) }), z.object({ all: z.literal(true) })]);

/** POST /api/notifications/read with { id } or { all: true }. */
export async function POST(req: Request) {
  const blocked = sameSiteOnly(req);
  if (blocked) return blocked;
  const r = await callerOr401();
  if ("error" in r) return r.error;
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { sql, businessId, userId } = r.caller;
  if ("all" in body.data) return NextResponse.json({ marked: await markAllRead(sql, businessId, userId) });
  const ok = await markRead(sql, businessId, userId, body.data.id);
  return ok ? NextResponse.json({ marked: 1 }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
