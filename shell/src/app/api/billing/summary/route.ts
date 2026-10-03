import { NextResponse } from "next/server";
import { HttpError } from "@founderos/sdk";
import { currentUsageSummary, getBillingConfig } from "@/lib/billing";
import { billingCaller } from "@/lib/billing/session";

export const dynamic = "force-dynamic";

/** Current plan, usage against limits, and whether billing is switched on. Any member of the business may read it. */
export async function GET() {
  try {
    const caller = await billingCaller();
    const cfg = getBillingConfig();
    const summary = await currentUsageSummary(caller.sql, caller.businessId);
    return NextResponse.json({ ...summary, billingEnabled: cfg.enabled, canManage: caller.role === "owner" || caller.role === "admin" });
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("billing summary", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
