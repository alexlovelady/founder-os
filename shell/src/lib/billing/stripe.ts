/**
 * Stripe over plain HTTPS (no SDK): checkout, billing portal, and signed webhooks. Nothing here runs unless STRIPE_SECRET_KEY is set.
 * Stripe is the source of truth: the subscriptions table only mirrors what Stripe tells us, and plan ids come from our own env price map,
 * never from the browser.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError, UUID_RE, type Sql } from "@founderos/sdk";
import { getPlan } from "@/config/plans";
import { PAID_PLANS, planForPrice, type BillingConfig, type PaidPlanId } from "./config";
import type { SubscriptionStatus } from "./core";

// ---------- HTTP layer (injectable) ----------

export type FormValue = string | number | boolean | null | undefined | FormValue[] | { [k: string]: FormValue };
export interface StripeApi {
  /** Call the Stripe REST API. `form` is sent form-encoded (nested keys become a[b][0]=...). Returns parsed JSON or throws HttpError. */
  request(method: "GET" | "POST", path: string, form?: { [k: string]: FormValue }, opts?: { idempotencyKey?: string }): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function encodeForm(obj: { [k: string]: FormValue }): string {
  const out = new URLSearchParams();
  const walk = (v: FormValue, key: string) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${key}[${k}]`);
    else out.append(key, String(v));
  };
  for (const [k, v] of Object.entries(obj)) walk(v, k);
  return out.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Real Stripe client. GETs retry a few times with backoff on network errors, 429 and 5xx; POSTs are never retried blindly. */
export function createStripeApi(secretKey: string, fetchImpl: typeof fetch = fetch): StripeApi {
  return {
    async request(method, path, form, opts) {
      const attempts = method === "GET" ? 3 : 1;
      let lastErr: HttpError = new HttpError(502, "Could not reach Stripe. Please try again in a moment.");
      for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(250 * 2 ** (i - 1));
        let res: Response;
        try {
          const headers: Record<string, string> = { authorization: `Bearer ${secretKey}` };
          if (method === "POST") headers["content-type"] = "application/x-www-form-urlencoded";
          if (opts?.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
          res = await fetchImpl(`https://api.stripe.com/v1${path}`, { method, headers, body: method === "POST" && form ? encodeForm(form) : undefined });
        } catch {
          lastErr = new HttpError(502, "Could not reach Stripe. Please try again in a moment.");
          continue;
        }
        const data = await res.json().catch(() => null);
        if (res.ok) return data;
        if (res.status === 429 || res.status >= 500) {
          lastErr = new HttpError(502, "Stripe is temporarily unavailable. Please try again in a moment.");
          continue;
        }
        console.error("stripe error", res.status, data?.error?.type, data?.error?.code);
        throw new HttpError(502, "Stripe could not complete that request.");
      }
      throw lastErr;
    },
  };
}

// ---------- Signature verification ----------

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureResult = { ok: true; timestamp: number } | { ok: false; reason: string };

/** Verify a Stripe-Signature header (`t=...,v1=...`) over the RAW request body. Constant-time compare, 5-minute tolerance. */
export function verifyStripeSignature(rawBody: string, header: string | null | undefined, secret: string, now: Date = new Date(), toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS): SignatureResult {
  if (!header) return { ok: false, reason: "missing signature" };
  let t: string | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v);
  }
  const ts = t !== null && /^\d{1,12}$/.test(t) ? Number(t) : NaN;
  if (!Number.isFinite(ts) || v1.length === 0) return { ok: false, reason: "malformed signature" };
  if (Math.abs(now.getTime() / 1000 - ts) > toleranceSeconds) return { ok: false, reason: "timestamp outside tolerance" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest();
  const match = v1.some((sig) => {
    if (!/^[0-9a-f]{64}$/i.test(sig)) return false;
    return timingSafeEqual(expected, Buffer.from(sig, "hex"));
  });
  return match ? { ok: true, timestamp: ts } : { ok: false, reason: "signature mismatch" };
}

/** Build a header for tests and the docs' local-test recipe. */
export function signStripePayload(rawBody: string, secret: string, timestampSeconds: number): string {
  return `t=${timestampSeconds},v1=${createHmac("sha256", secret).update(`${timestampSeconds}.${rawBody}`, "utf8").digest("hex")}`;
}

// ---------- Roles ----------

/** Only owners and admins may start checkout or open the billing portal. */
export function assertCanManageBilling(role: string): void {
  if (role !== "owner" && role !== "admin") throw new HttpError(403, "Only the business owner or an admin can manage billing.");
}

// ---------- Checkout and portal ----------

export interface BillingDeps {
  config: BillingConfig;
  /** Stripe HTTP layer; defaults to the real one built from config.secretKey. */
  stripe?: StripeApi;
}

function requireStripe(deps: BillingDeps): StripeApi {
  if (!deps.config.enabled || !deps.config.secretKey) throw new HttpError(503, "Billing is not enabled yet. Every business is on the Free plan for now.");
  return deps.stripe ?? createStripeApi(deps.config.secretKey);
}

const LIVE_STATUSES: SubscriptionStatus[] = ["active", "trialing", "past_due"];

export async function createCheckoutSession(
  sql: Sql,
  input: { businessId: string; role: string; plan: string; email?: string | null; returnBaseUrl: string },
  deps: BillingDeps,
): Promise<{ url: string }> {
  assertCanManageBilling(input.role);
  const stripe = requireStripe(deps);
  // The plan name from the browser is only used to pick one of OUR plans; the price id comes from our environment.
  const plan = PAID_PLANS.find((p) => p === input.plan);
  if (!plan) throw new HttpError(400, "Choose one of the paid plans.");
  const price = deps.config.prices[plan];
  if (!price) throw new HttpError(503, `The ${getPlan(plan).name} plan is not available to buy yet.`);

  const [existing] = await sql<{ status: SubscriptionStatus; stripe_customer_id: string | null; stripe_subscription_id: string | null }[]>`
    SELECT status, stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE business_id = ${input.businessId}`;
  if (existing && LIVE_STATUSES.includes(existing.status) && existing.stripe_subscription_id) {
    throw new HttpError(409, "This business already has a subscription. Use Manage subscription to change plan or payment details.");
  }
  const form: { [k: string]: FormValue } = {
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: input.businessId,
    metadata: { business_id: input.businessId, plan },
    subscription_data: { metadata: { business_id: input.businessId, plan }, ...(deps.config.trialDays > 0 ? { trial_period_days: deps.config.trialDays } : {}) },
    allow_promotion_codes: true,
    success_url: `${input.returnBaseUrl}/app/billing?checkout=success`,
    cancel_url: `${input.returnBaseUrl}/app/billing?checkout=canceled`,
  };
  if (existing?.stripe_customer_id) form.customer = existing.stripe_customer_id;
  else if (input.email) form.customer_email = input.email;
  const session = await stripe.request("POST", "/checkout/sessions", form);
  if (!session?.url || typeof session.url !== "string") throw new HttpError(502, "Stripe did not return a checkout link.");
  return { url: session.url };
}

export async function createPortalSession(
  sql: Sql,
  input: { businessId: string; role: string; returnBaseUrl: string },
  deps: BillingDeps,
): Promise<{ url: string }> {
  assertCanManageBilling(input.role);
  const stripe = requireStripe(deps);
  const [row] = await sql<{ stripe_customer_id: string | null }[]>`SELECT stripe_customer_id FROM subscriptions WHERE business_id = ${input.businessId}`;
  if (!row?.stripe_customer_id) throw new HttpError(400, "There is no paid subscription to manage yet.");
  const session = await stripe.request("POST", "/billing_portal/sessions", { customer: row.stripe_customer_id, return_url: `${input.returnBaseUrl}/app/billing` });
  if (!session?.url || typeof session.url !== "string") throw new HttpError(502, "Stripe did not return a billing link.");
  return { url: session.url };
}

// ---------- Webhook ----------

/* eslint-disable @typescript-eslint/no-explicit-any -- Stripe payloads are external JSON; every field read below is checked */
interface StripeEvent { id: string; type: string; created: number; data: { object: any } }

export interface WebhookDeps {
  config: BillingConfig;
  stripe?: StripeApi;
  now?: Date;
}
export interface WebhookResult {
  status: number;
  body: { received?: boolean; duplicate?: boolean; ignored?: string; error?: string };
}

const idOf = (v: any): string | null => (typeof v === "string" ? v : v && typeof v.id === "string" ? v.id : null);
const businessIdFrom = (md: any): string | null => (md && typeof md.business_id === "string" && UUID_RE.test(md.business_id) ? md.business_id : null);

export function mapStripeStatus(s: string): SubscriptionStatus {
  switch (s) {
    case "active": case "trialing": case "past_due": case "canceled": case "unpaid": return s;
    case "incomplete_expired": case "paused": return "canceled";
    default: return "none"; // incomplete
  }
}

type Tx = Sql;
interface Row { business_id: string; plan: string; status: SubscriptionStatus; stripe_customer_id: string | null; stripe_subscription_id: string | null; current_period_end: Date | null; last_event_at: Date | null }

async function findRow(tx: Tx, o: { businessId?: string | null; customer?: string | null; subscription?: string | null }): Promise<Row | null> {
  if (o.businessId) {
    const [r] = await tx<Row[]>`SELECT * FROM subscriptions WHERE business_id = ${o.businessId} FOR UPDATE`;
    if (r) return r;
  }
  if (o.subscription) {
    const [r] = await tx<Row[]>`SELECT * FROM subscriptions WHERE stripe_subscription_id = ${o.subscription} FOR UPDATE`;
    if (r) return r;
  }
  if (o.customer) {
    const [r] = await tx<Row[]>`SELECT * FROM subscriptions WHERE stripe_customer_id = ${o.customer} FOR UPDATE`;
    if (r) return r;
  }
  return null;
}

const businessExists = async (tx: Tx, id: string) => (await tx`SELECT 1 FROM businesses WHERE id = ${id}`).length > 0;
const periodEnd = (sub: any): Date | null => {
  const s = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end; // newer API versions move it onto the item
  return typeof s === "number" ? new Date(s * 1000) : null;
};

/** Apply a Stripe subscription object to our mirror. Returns a note when it was ignored. */
async function applySubscription(sql: Sql, sub: any, createdAt: Date, cfg: BillingConfig): Promise<string | null> {
  const customer = idOf(sub?.customer);
  const subId = idOf(sub);
  if (!subId) return "subscription without id";
  const priceId = sub?.items?.data?.[0]?.price?.id;
  const plan: PaidPlanId | null = planForPrice(cfg.prices, priceId);
  if (!plan) return `ignored: price ${priceId ?? "(none)"} is not mapped to a plan`;
  const status = mapStripeStatus(String(sub.status));
  const mdBusiness = businessIdFrom(sub.metadata);
  return sql.begin(async (t) => {
    const tx = t as unknown as Tx;
    const row = await findRow(tx, { businessId: mdBusiness, subscription: subId, customer });
    const businessId = mdBusiness ?? row?.business_id ?? null;
    if (!businessId) return "ignored: subscription does not belong to a known business";
    if (!(await businessExists(tx, businessId))) return "ignored: business no longer exists";
    if (row?.last_event_at && row.last_event_at > createdAt) return "ignored: a newer event was already applied";
    // A late event about an old, replaced subscription must not cancel the current one.
    if (row?.stripe_subscription_id && row.stripe_subscription_id !== subId && ["active", "trialing", "past_due"].includes(row.status) && !["active", "trialing", "past_due"].includes(status)) {
      return "ignored: event is for a previous subscription";
    }
    await tx`
      INSERT INTO subscriptions (business_id, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end, past_due_since, last_event_at, updated_at)
      VALUES (${businessId}, ${plan}, ${status}, ${customer}, ${subId}, ${periodEnd(sub)}, ${Boolean(sub.cancel_at_period_end)},
              ${status === "past_due" ? createdAt : null}, ${createdAt}, now())
      ON CONFLICT (business_id) DO UPDATE SET
        plan = EXCLUDED.plan, status = EXCLUDED.status, stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id),
        stripe_subscription_id = EXCLUDED.stripe_subscription_id, current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end,
        past_due_since = CASE WHEN EXCLUDED.status = 'past_due' THEN COALESCE(subscriptions.past_due_since, EXCLUDED.past_due_since) ELSE NULL END,
        last_event_at = EXCLUDED.last_event_at, updated_at = now()`;
    return null;
  });
}

async function applyInvoice(sql: Sql, type: string, inv: any, createdAt: Date): Promise<string | null> {
  const customer = idOf(inv?.customer);
  const subId = idOf(inv?.subscription) ?? idOf(inv?.parent?.subscription_details?.subscription);
  return sql.begin(async (t) => {
    const tx = t as unknown as Tx;
    const row = await findRow(tx, { subscription: subId, customer });
    if (!row) return "ignored: no matching subscription yet";
    if (row.last_event_at && row.last_event_at > createdAt) return "ignored: a newer event was already applied";
    if (type === "invoice.payment_failed") {
      if (!["active", "trialing", "past_due"].includes(row.status)) return "ignored: subscription is not live";
      await tx`UPDATE subscriptions SET status = 'past_due', past_due_since = COALESCE(past_due_since, ${createdAt}), last_event_at = ${createdAt}, updated_at = now() WHERE business_id = ${row.business_id}`;
      return null;
    }
    // invoice.paid: a paid invoice clears a past_due/unpaid state and moves the period end forward.
    const ends = ((inv?.lines?.data ?? []) as any[]).map((l) => l?.period?.end).filter((n) => typeof n === "number") as number[];
    const newEnd = ends.length ? new Date(Math.max(...ends) * 1000) : null;
    const revive = row.status === "past_due" || row.status === "unpaid";
    await tx`
      UPDATE subscriptions SET
        status = CASE WHEN ${revive} THEN 'active' ELSE status END,
        past_due_since = CASE WHEN ${revive} THEN NULL ELSE past_due_since END,
        current_period_end = CASE WHEN ${newEnd}::timestamptz IS NOT NULL AND (current_period_end IS NULL OR ${newEnd}::timestamptz > current_period_end) THEN ${newEnd}::timestamptz ELSE current_period_end END,
        last_event_at = ${createdAt}, updated_at = now()
      WHERE business_id = ${row.business_id}`;
    return null;
  });
}

async function applyCheckout(sql: Sql, session: any, createdAt: Date, deps: WebhookDeps): Promise<string | null> {
  if (session?.mode !== "subscription") return "ignored: not a subscription checkout";
  const businessId = businessIdFrom(session.metadata) ?? (typeof session.client_reference_id === "string" && UUID_RE.test(session.client_reference_id) ? session.client_reference_id : null);
  const customer = idOf(session.customer);
  const subId = idOf(session.subscription);
  if (!businessId) return "ignored: checkout has no business reference";
  const linked = await sql.begin(async (t) => {
    const tx = t as unknown as Tx;
    if (!(await businessExists(tx, businessId))) return false;
    await tx`
      INSERT INTO subscriptions (business_id, stripe_customer_id, stripe_subscription_id, updated_at)
      VALUES (${businessId}, ${customer}, ${subId}, now())
      ON CONFLICT (business_id) DO UPDATE SET stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, subscriptions.stripe_customer_id), updated_at = now()`;
    return true;
  });
  if (!linked) return "ignored: business no longer exists";
  // Stripe is the source of truth: read the subscription it created and mirror it. Without a Stripe client, the subscription.* events do it.
  if (subId && deps.config.secretKey) {
    const stripe = deps.stripe ?? createStripeApi(deps.config.secretKey);
    const sub = await stripe.request("GET", `/subscriptions/${encodeURIComponent(subId)}`);
    return applySubscription(sql, { ...sub, metadata: { ...(sub?.metadata ?? {}), business_id: sub?.metadata?.business_id ?? businessId } }, createdAt, deps.config);
  }
  return null;
}

/** Process one Stripe webhook call. `rawBody` MUST be the unparsed request text (the signature covers the exact bytes). */
export async function handleWebhook(sql: Sql, rawBody: string, signatureHeader: string | null | undefined, deps: WebhookDeps): Promise<WebhookResult> {
  if (!deps.config.webhookSecret) return { status: 503, body: { error: "Stripe webhooks are not enabled." } };
  const sig = verifyStripeSignature(rawBody, signatureHeader, deps.config.webhookSecret, deps.now ?? new Date());
  if (!sig.ok) return { status: 400, body: { error: `Invalid signature (${sig.reason})` } };
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: "Body is not JSON" } };
  }
  if (!event || typeof event.id !== "string" || typeof event.type !== "string" || !event.data?.object) return { status: 400, body: { error: "Not a Stripe event" } };

  const claimed = await sql`INSERT INTO stripe_events (event_id, type) VALUES (${event.id}, ${event.type}) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`;
  if (claimed.length === 0) {
    const [prev] = await sql<{ processed_at: Date | null }[]>`SELECT processed_at FROM stripe_events WHERE event_id = ${event.id}`;
    if (prev?.processed_at) return { status: 200, body: { received: true, duplicate: true } };
    // A previous attempt failed part-way: process it again (every handler below is safe to repeat).
  }
  const createdAt = new Date((typeof event.created === "number" ? event.created : Math.floor((deps.now ?? new Date()).getTime() / 1000)) * 1000);
  try {
    let note: string | null = null;
    const obj = event.data.object;
    switch (event.type) {
      case "checkout.session.completed": note = await applyCheckout(sql, obj, createdAt, deps); break;
      case "customer.subscription.created":
      case "customer.subscription.updated": note = await applySubscription(sql, obj, createdAt, deps.config); break;
      case "customer.subscription.deleted": note = await applySubscription(sql, { ...obj, status: "canceled" }, createdAt, deps.config); break;
      case "invoice.paid":
      case "invoice.payment_failed": note = await applyInvoice(sql, event.type, obj, createdAt); break;
      default: note = "ignored: event type not used";
    }
    await sql`UPDATE stripe_events SET processed_at = now(), error = ${note} WHERE event_id = ${event.id}`;
    return { status: 200, body: note ? { received: true, ignored: note } : { received: true } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    await sql`UPDATE stripe_events SET error = ${msg.slice(0, 500)} WHERE event_id = ${event.id}`;
    console.error("stripe webhook failed", event.type, msg);
    return { status: 500, body: { error: "Could not process the event; Stripe will retry." } }; // non-2xx makes Stripe retry with backoff
  }
}
