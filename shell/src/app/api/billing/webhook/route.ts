import { NextResponse } from "next/server";
import { getBillingConfig, handleWebhook } from "@/lib/billing";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Stripe calls this. Public (no session) but every call is verified against STRIPE_WEBHOOK_SECRET using the exact raw body. */
export async function POST(req: Request) {
  const raw = await req.text(); // must stay raw: the signature covers the exact bytes
  const result = await handleWebhook(db(), raw, req.headers.get("stripe-signature"), { config: getBillingConfig() });
  return NextResponse.json(result.body, { status: result.status });
}
