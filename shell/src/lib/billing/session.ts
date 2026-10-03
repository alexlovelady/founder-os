import { HttpError } from "@founderos/sdk";
import { getSession } from "../auth/server";
import { currentBusiness } from "../business";
import { db } from "../db";
import { getBillingConfig } from "./config";

/** Who is calling and for which business, from the verified session (never from the request body). */
export async function billingCaller() {
  const session = await getSession();
  if (!session) throw new HttpError(401, "Not signed in");
  const business = await currentBusiness(session.user.id);
  if (!business) throw new HttpError(404, "No business yet");
  return { sql: db(), businessId: business.id, role: business.role, email: session.user.email, userId: session.user.id };
}

/** Public origin for Stripe return links: APP_URL when configured, else the proxy headers, else the request URL. */
export function returnBaseUrl(req: Request): string {
  const cfg = getBillingConfig();
  if (cfg.appUrl) return cfg.appUrl;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}
