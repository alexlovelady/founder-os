import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError } from "@founderos/sdk";
import { createCheckoutSession, getBillingConfig } from "@/lib/billing";
import { billingCaller, returnBaseUrl } from "@/lib/billing/session";

export const dynamic = "force-dynamic";

/** Start a Stripe Checkout for a paid plan. Owner/admin only. The browser sends only the plan name; the price comes from the server's env. */
export async function POST(req: Request) {
  try {
    const caller = await billingCaller();
    const body = z.object({ plan: z.string().max(40) }).safeParse(await req.json().catch(() => null));
    if (!body.success) throw new HttpError(400, "Choose a plan");
    const out = await createCheckoutSession(
      caller.sql,
      { businessId: caller.businessId, role: caller.role, plan: body.data.plan, email: caller.email, returnBaseUrl: returnBaseUrl(req) },
      { config: getBillingConfig() },
    );
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.error("billing checkout", e);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
