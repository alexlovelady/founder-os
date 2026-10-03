import { NextResponse } from "next/server";
import { HttpError } from "@founderos/sdk";
import { createPortalSession, getBillingConfig } from "@/lib/billing";
import { billingCaller, returnBaseUrl } from "@/lib/billing/session";

export const dynamic = "force-dynamic";

/** Open the Stripe Billing Portal (change plan, update card, cancel, invoices). Owner/admin only. */
export async function POST(req: Request) {
  try {
    const caller = await billingCaller();
    const out = await createPortalSession(caller.sql, { businessId: caller.businessId, role: caller.role, returnBaseUrl: returnBaseUrl(req) }, { config: getBillingConfig() });
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("billing portal", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
