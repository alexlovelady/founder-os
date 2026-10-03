import { NextResponse } from "next/server";
import { unreadCount } from "@/lib/notify";
import { callerOr401 } from "@/lib/notify/http";

export const dynamic = "force-dynamic";

export async function GET() {
  const r = await callerOr401();
  if ("error" in r) return r.error;
  return NextResponse.json({ unread: await unreadCount(r.caller.sql, r.caller.businessId, r.caller.userId) });
}
