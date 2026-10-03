import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import {
  assertCanManageBilling, createCheckoutSession, createPortalSession, encodeForm, getBillingConfig, getBusinessPlan, handleWebhook, signStripePayload,
  verifyStripeSignature, type BillingConfig, type StripeApi,
} from "@/lib/billing";

const SECRET = "whsec_test_secret";
const config: BillingConfig = getBillingConfig({
  STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_PRICE_FOUNDER: "price_f", STRIPE_PRICE_PRO: "price_p", STRIPE_PRICE_BUSINESS: "price_b",
  STRIPE_TRIAL_DAYS: "14", APP_URL: "https://app.test/",
});

/** A fake Stripe HTTP layer: records calls and answers from a table. No network. */
function fakeStripe(answers: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; form?: Record<string, unknown> }[] = [];
  const api: StripeApi = {
    async request(method, path, form) {
      calls.push({ method, path, form: form as Record<string, unknown> });
      const a = answers[`${method} ${path}`];
      if (a === undefined) throw new Error(`unexpected stripe call ${method} ${path}`);
      return a;
    },
  };
  return { api, calls };
}

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv([]);
  // Fixed Stripe customer ids are reused across runs, so start from a clean slate.
  await env.sql`DELETE FROM subscriptions`;
  await env.sql`DELETE FROM stripe_events`;
});
afterAll(async () => {
  await env.sql`DELETE FROM subscriptions`;
  await env.sql`DELETE FROM stripe_events`;
  await env.cleanup();
});

let seq = 0;
const nowSec = () => Math.floor(Date.now() / 1000);
async function newBusiness(): Promise<string> {
  const [b] = await env.sql<{ id: string }[]>`INSERT INTO businesses (name) VALUES ('Stripe Test') RETURNING id`;
  return b.id;
}
function event(type: string, object: unknown, created = nowSec(), id = `evt_${++seq}_${Math.random().toString(36).slice(2)}`) {
  return { id, type, created, data: { object } };
}
async function send(ev: unknown, opts: { stripe?: StripeApi; secret?: string; at?: number } = {}) {
  const raw = JSON.stringify(ev);
  const header = signStripePayload(raw, opts.secret ?? SECRET, opts.at ?? nowSec());
  return handleWebhook(env.sql, raw, header, { config, stripe: opts.stripe });
}
const sub = (business: string | null, over: Record<string, unknown> = {}) => ({
  id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, current_period_end: nowSec() + 30 * 86400,
  items: { data: [{ price: { id: "price_p" } }] }, metadata: business ? { business_id: business } : {}, ...over,
});
const row = async (b: string) => (await env.sql`SELECT * FROM subscriptions WHERE business_id = ${b}`)[0];

describe("signature verification", () => {
  const body = '{"id":"evt_x"}';
  const now = new Date();
  const t = Math.floor(now.getTime() / 1000);

  it("accepts a correct signature", () => {
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, t), SECRET, now).ok).toBe(true);
  });
  it("accepts when one of several v1 signatures matches", () => {
    const good = signStripePayload(body, SECRET, t);
    expect(verifyStripeSignature(body, `${good},v1=${"0".repeat(64)}`, SECRET, now).ok).toBe(true);
  });
  it("rejects a wrong secret, a tampered body, and missing or malformed headers", () => {
    expect(verifyStripeSignature(body, signStripePayload(body, "other", t), SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(body + " ", signStripePayload(body, SECRET, t), SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(body, null, SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(body, "garbage", SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=short`, SECRET, now).ok).toBe(false);
  });
  it("enforces the 5 minute tolerance in both directions", () => {
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, t - 299), SECRET, now).ok).toBe(true);
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, t - 301), SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(body, signStripePayload(body, SECRET, t + 301), SECRET, now).ok).toBe(false);
  });
  it("a replayed old (but validly signed) payload is rejected", () => {
    const old = signStripePayload(body, SECRET, t - 3600);
    expect(verifyStripeSignature(body, old, SECRET, now)).toMatchObject({ ok: false });
  });
});

describe("webhook endpoint behaviour", () => {
  it("returns 400 for a bad signature and changes nothing", async () => {
    const b = await newBusiness();
    const ev = event("customer.subscription.created", sub(b));
    const r = await send(ev, { secret: "wrong" });
    expect(r.status).toBe(400);
    expect(await row(b)).toBeUndefined();
    expect(await env.sql`SELECT 1 FROM stripe_events WHERE event_id = ${ev.id}`).toHaveLength(0);
  });

  it("returns 400 for a stale timestamp", async () => {
    const ev = event("customer.subscription.created", sub(null));
    expect((await send(ev, { at: nowSec() - 1000 })).status).toBe(400);
  });

  it("is off (503) when no webhook secret is configured", async () => {
    const r = await handleWebhook(env.sql, "{}", "t=1,v1=00", { config: getBillingConfig({}) });
    expect(r.status).toBe(503);
  });

  it("is idempotent: the same event id is applied once", async () => {
    const b = await newBusiness();
    const ev = event("customer.subscription.created", sub(b, { id: "sub_idem", customer: "cus_idem" }));
    expect((await send(ev)).body).toEqual({ received: true });
    await env.sql`UPDATE subscriptions SET plan = 'founder' WHERE business_id = ${b}`; // a later change that a replay must not undo
    const again = await send(ev);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect((await row(b)).plan).toBe("founder");
  });

  it("an unprocessed (failed) event is retried on redelivery", async () => {
    const b = await newBusiness();
    const ev = event("checkout.session.completed", { mode: "subscription", client_reference_id: b, customer: "cus_retry", subscription: "sub_retry", metadata: { business_id: b } });
    const failing = fakeStripe({}); // GET /subscriptions/... throws -> 500
    expect((await send(ev, { stripe: failing.api })).status).toBe(500);
    const [e1] = await env.sql`SELECT processed_at, error FROM stripe_events WHERE event_id = ${ev.id}`;
    expect(e1.processed_at).toBeNull();
    expect(e1.error).toBeTruthy();
    const ok = fakeStripe({ "GET /subscriptions/sub_retry": sub(b, { id: "sub_retry", customer: "cus_retry" }) });
    expect((await send(ev, { stripe: ok.api })).status).toBe(200);
    expect((await row(b)).status).toBe("active");
  });
});

describe("event effects", () => {
  it("customer.subscription.created makes the business paid, from the env price map", async () => {
    const b = await newBusiness();
    await send(event("customer.subscription.created", sub(b)));
    const r = await row(b);
    expect(r).toMatchObject({ plan: "pro", status: "active", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", cancel_at_period_end: false });
    expect(r.current_period_end).toBeInstanceOf(Date);
    expect((await getBusinessPlan(env.sql, b)).id).toBe("pro");
  });

  it("reads the period end from the item on newer API versions", async () => {
    const b = await newBusiness();
    const end = nowSec() + 12345;
    await send(event("customer.subscription.created", sub(b, { id: "sub_item", customer: "cus_item", current_period_end: undefined, items: { data: [{ price: { id: "price_f" }, current_period_end: end }] } })));
    expect((await row(b)).current_period_end.getTime()).toBe(end * 1000);
    expect((await row(b)).plan).toBe("founder");
  });

  it("customer.subscription.updated changes plan, status and cancel flag", async () => {
    const b = await newBusiness();
    const t0 = nowSec() - 100;
    await send(event("customer.subscription.created", sub(b, { id: "sub_u", customer: "cus_u" }), t0));
    await send(event("customer.subscription.updated", sub(b, { id: "sub_u", customer: "cus_u", items: { data: [{ price: { id: "price_b" } }] }, cancel_at_period_end: true }), t0 + 10));
    expect(await row(b)).toMatchObject({ plan: "business", status: "active", cancel_at_period_end: true });
  });

  it("finds the business by customer id when metadata is missing (e.g. a portal change)", async () => {
    const b = await newBusiness();
    const t0 = nowSec() - 100;
    await send(event("customer.subscription.created", sub(b, { id: "sub_c", customer: "cus_c" }), t0));
    await send(event("customer.subscription.updated", sub(null, { id: "sub_c", customer: "cus_c", items: { data: [{ price: { id: "price_f" } }] } }), t0 + 5));
    expect((await row(b)).plan).toBe("founder");
  });

  it("an unknown price id is ignored and never guessed", async () => {
    const b = await newBusiness();
    const r = await send(event("customer.subscription.created", sub(b, { id: "sub_unk", items: { data: [{ price: { id: "price_mystery" } }] } })));
    expect(r.status).toBe(200);
    expect(r.body.ignored).toContain("price_mystery");
    expect(await row(b)).toBeUndefined();
  });

  it("a subscription for an unknown business is ignored", async () => {
    const r = await send(event("customer.subscription.created", sub("11111111-1111-4111-8111-111111111111", { id: "sub_nobiz", customer: "cus_nobiz" })));
    expect(r.status).toBe(200);
    expect(r.body.ignored).toBeTruthy();
  });

  it("trialing counts as the paid plan", async () => {
    const b = await newBusiness();
    await send(event("customer.subscription.created", sub(b, { id: "sub_t", customer: "cus_t", status: "trialing" })));
    expect((await row(b)).status).toBe("trialing");
    expect((await getBusinessPlan(env.sql, b)).id).toBe("pro");
  });

  it("customer.subscription.deleted cancels and the business drops to free", async () => {
    const b = await newBusiness();
    const t0 = nowSec() - 100;
    await send(event("customer.subscription.created", sub(b, { id: "sub_d", customer: "cus_d" }), t0));
    await send(event("customer.subscription.deleted", sub(b, { id: "sub_d", customer: "cus_d", status: "canceled" }), t0 + 5));
    expect((await row(b)).status).toBe("canceled");
    expect((await getBusinessPlan(env.sql, b)).id).toBe("free");
  });

  it("a late deleted event for an OLD subscription does not cancel the current one", async () => {
    const b = await newBusiness();
    const t0 = nowSec() - 100;
    await send(event("customer.subscription.created", sub(b, { id: "sub_new", customer: "cus_o" }), t0));
    const r = await send(event("customer.subscription.deleted", sub(b, { id: "sub_old", customer: "cus_o" }), t0 + 5));
    expect(r.body.ignored).toBeTruthy();
    expect((await row(b)).status).toBe("active");
  });

  it("an older event arriving late does not overwrite a newer state", async () => {
    const b = await newBusiness();
    const t0 = nowSec() - 100;
    await send(event("customer.subscription.updated", sub(b, { id: "sub_o", customer: "cus_oo", status: "past_due" }), t0 + 50));
    const r = await send(event("customer.subscription.updated", sub(b, { id: "sub_o", customer: "cus_oo", status: "active" }), t0));
    expect(r.body.ignored).toBeTruthy();
    expect((await row(b)).status).toBe("past_due");
  });

  it("invoice.payment_failed sets past_due with a grace start; invoice.paid clears it", async () => {
    const b = await newBusiness();
    const t0 = nowSec() - 100;
    await send(event("customer.subscription.created", sub(b, { id: "sub_i", customer: "cus_i" }), t0));
    await send(event("invoice.payment_failed", { customer: "cus_i", subscription: "sub_i" }, t0 + 10));
    let r = await row(b);
    expect(r.status).toBe("past_due");
    expect(r.past_due_since).toBeInstanceOf(Date);
    expect((await getBusinessPlan(env.sql, b)).id).toBe("pro"); // inside the grace period
    const newEnd = nowSec() + 40 * 86400;
    await send(event("invoice.paid", { customer: "cus_i", parent: { subscription_details: { subscription: "sub_i" } }, lines: { data: [{ period: { end: newEnd } }] } }, t0 + 20));
    r = await row(b);
    expect(r.status).toBe("active");
    expect(r.past_due_since).toBeNull();
    expect(r.current_period_end.getTime()).toBe(newEnd * 1000);
  });

  it("repeated payment failures keep the original grace start", async () => {
    const b = await newBusiness();
    const t0 = nowSec() - 1000;
    await send(event("customer.subscription.created", sub(b, { id: "sub_r", customer: "cus_r" }), t0));
    await send(event("invoice.payment_failed", { customer: "cus_r", subscription: "sub_r" }, t0 + 10));
    const first = (await row(b)).past_due_since.getTime();
    await send(event("invoice.payment_failed", { customer: "cus_r", subscription: "sub_r" }, t0 + 500));
    expect((await row(b)).past_due_since.getTime()).toBe(first);
  });

  it("invoice events for a canceled subscription do not revive it", async () => {
    const b = await newBusiness();
    const t0 = nowSec() - 100;
    await send(event("customer.subscription.created", sub(b, { id: "sub_x", customer: "cus_x", status: "canceled" }), t0));
    await send(event("invoice.payment_failed", { customer: "cus_x", subscription: "sub_x" }, t0 + 10));
    expect((await row(b)).status).toBe("canceled");
  });

  it("checkout.session.completed links the customer and mirrors the subscription read from Stripe", async () => {
    const b = await newBusiness();
    const fake = fakeStripe({ "GET /subscriptions/sub_co": sub(null, { id: "sub_co", customer: "cus_co", items: { data: [{ price: { id: "price_b" } }] } }) });
    await send(event("checkout.session.completed", { mode: "subscription", client_reference_id: b, customer: "cus_co", subscription: "sub_co", metadata: { business_id: b } }), { stripe: fake.api });
    expect(fake.calls).toHaveLength(1);
    expect(await row(b)).toMatchObject({ plan: "business", status: "active", stripe_customer_id: "cus_co", stripe_subscription_id: "sub_co" });
  });

  it("checkout.session.completed ignores non-subscription sessions and unknown event types", async () => {
    const r1 = await send(event("checkout.session.completed", { mode: "payment" }));
    expect(r1.body.ignored).toBeTruthy();
    const r2 = await send(event("charge.refunded", { id: "ch_1" }));
    expect(r2.status).toBe(200);
    expect(r2.body.ignored).toBeTruthy();
  });
});

describe("checkout and portal", () => {
  it("only owners and admins may manage billing", () => {
    expect(() => assertCanManageBilling("owner")).not.toThrow();
    expect(() => assertCanManageBilling("admin")).not.toThrow();
    expect(() => assertCanManageBilling("member")).toThrow(/owner or an admin/);
    expect(() => assertCanManageBilling("viewer")).toThrow();
  });

  it("refuses members and viewers before touching Stripe", async () => {
    const fake = fakeStripe();
    for (const role of ["member", "viewer"]) {
      await expect(createCheckoutSession(env.sql, { businessId: env.ctx.businessId, role, plan: "pro", returnBaseUrl: "https://app.test" }, { config, stripe: fake.api })).rejects.toMatchObject({ status: 403 });
      await expect(createPortalSession(env.sql, { businessId: env.ctx.businessId, role, returnBaseUrl: "https://app.test" }, { config, stripe: fake.api })).rejects.toMatchObject({ status: 403 });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("is honestly unavailable without Stripe keys", async () => {
    const off = getBillingConfig({});
    expect(off.enabled).toBe(false);
    await expect(createCheckoutSession(env.sql, { businessId: env.ctx.businessId, role: "owner", plan: "pro", returnBaseUrl: "x" }, { config: off })).rejects.toMatchObject({ status: 503, message: expect.stringContaining("not enabled") });
    await expect(createPortalSession(env.sql, { businessId: env.ctx.businessId, role: "owner", returnBaseUrl: "x" }, { config: off })).rejects.toMatchObject({ status: 503 });
  });

  it("creates a checkout session using the server's price id, business reference and trial days", async () => {
    const b = await newBusiness();
    const fake = fakeStripe({ "POST /checkout/sessions": { url: "https://checkout.stripe.test/s1" } });
    const out = await createCheckoutSession(env.sql, { businessId: b, role: "owner", plan: "founder", email: "o@x.test", returnBaseUrl: "https://app.test" }, { config, stripe: fake.api });
    expect(out.url).toBe("https://checkout.stripe.test/s1");
    const form = fake.calls[0].form as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(form.line_items[0].price).toBe("price_f");
    expect(form.client_reference_id).toBe(b);
    expect(form.subscription_data).toMatchObject({ trial_period_days: 14, metadata: { business_id: b } });
    expect(form.customer_email).toBe("o@x.test");
    expect(form.success_url).toBe("https://app.test/app/billing?checkout=success");
    expect(encodeForm(form)).toContain("line_items%5B0%5D%5Bprice%5D=price_f");
  });

  it("rejects free, unknown and unpriced plans (a plan name from the browser is never trusted)", async () => {
    const fake = fakeStripe({ "POST /checkout/sessions": { url: "u" } });
    for (const plan of ["free", "platinum", "price_p"]) {
      await expect(createCheckoutSession(env.sql, { businessId: env.ctx.businessId, role: "owner", plan, returnBaseUrl: "x" }, { config, stripe: fake.api })).rejects.toMatchObject({ status: 400 });
    }
    const noPrices = getBillingConfig({ STRIPE_SECRET_KEY: "sk_test_x" });
    await expect(createCheckoutSession(env.sql, { businessId: env.ctx.businessId, role: "owner", plan: "pro", returnBaseUrl: "x" }, { config: noPrices, stripe: fake.api })).rejects.toMatchObject({ status: 503 });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a second checkout when a subscription is already live, and reuses a known customer otherwise", async () => {
    const b = await newBusiness();
    await env.sql`INSERT INTO subscriptions (business_id, plan, status, stripe_customer_id, stripe_subscription_id) VALUES (${b}, 'pro', 'active', 'cus_live', 'sub_live')`;
    const fake = fakeStripe({ "POST /checkout/sessions": { url: "u" } });
    await expect(createCheckoutSession(env.sql, { businessId: b, role: "admin", plan: "business", returnBaseUrl: "x" }, { config, stripe: fake.api })).rejects.toMatchObject({ status: 409 });
    await env.sql`UPDATE subscriptions SET status = 'canceled' WHERE business_id = ${b}`;
    await createCheckoutSession(env.sql, { businessId: b, role: "admin", plan: "business", email: "e@x.test", returnBaseUrl: "x" }, { config, stripe: fake.api });
    expect((fake.calls[0].form as Record<string, unknown>).customer).toBe("cus_live");
  });

  it("opens the billing portal for the stored customer, and says so when there is none", async () => {
    const b = await newBusiness();
    const fake = fakeStripe({ "POST /billing_portal/sessions": { url: "https://portal.stripe.test/p" } });
    await expect(createPortalSession(env.sql, { businessId: b, role: "owner", returnBaseUrl: "https://app.test" }, { config, stripe: fake.api })).rejects.toMatchObject({ status: 400 });
    await env.sql`INSERT INTO subscriptions (business_id, stripe_customer_id) VALUES (${b}, 'cus_portal')`;
    const out = await createPortalSession(env.sql, { businessId: b, role: "owner", returnBaseUrl: "https://app.test" }, { config, stripe: fake.api });
    expect(out.url).toBe("https://portal.stripe.test/p");
    expect(fake.calls[0].form).toMatchObject({ customer: "cus_portal", return_url: "https://app.test/app/billing" });
  });
});

describe("config", () => {
  it("is disabled without a secret key and parses trial days defensively", () => {
    expect(getBillingConfig({}).enabled).toBe(false);
    expect(getBillingConfig({ STRIPE_SECRET_KEY: "  " }).enabled).toBe(false);
    expect(getBillingConfig({ STRIPE_TRIAL_DAYS: "abc" }).trialDays).toBe(0);
    expect(getBillingConfig({ STRIPE_TRIAL_DAYS: "-3" }).trialDays).toBe(0);
    expect(config.trialDays).toBe(14);
    expect(config.appUrl).toBe("https://app.test");
  });
});
