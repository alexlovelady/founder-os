import { NextResponse } from "next/server";
import { listNotifications, unreadCount } from "@/lib/notify";
import { callerOr401 } from "@/lib/notify/http";

export const dynamic = "force-dynamic";

/** GET /api/notifications?limit=10&unread=1 -> { items, unread } for the signed-in user in their business. */
export async function GET(req: Request) {
  const r = await callerOr401();
  if ("error" in r) return r.error;
  const { sql, businessId, userId } = r.caller;
  const u = new URL(req.url);
  const limit = Number(u.searchParams.get("limit")) || 30;
  const [items, unread] = await Promise.all([
    listNotifications(sql, businessId, userId, { limit, unreadOnly: u.searchParams.get("unread") === "1" }),
    unreadCount(sql, businessId, userId),
  ]);
  return NextResponse.json({ items, unread });
}
