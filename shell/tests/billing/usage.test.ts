import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "@founderos/sdk";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { getPlan } from "@/config/plans";
import {
  clearPlanOverride, currentUsageSummary, effectivePlan, getBusinessPlan, listSubscriptions, recordUsage, setPlanOverride, usageThisPeriod, useQuota,
  type SubscriptionRow,
} from "@/lib/billing";

let env: TestEnv;
beforeAll(async () => {
  env = await makeTestEnv([]);
});
afterAll(async () => {
  await env.cleanup();
});

const DAY = 86_400_000;
async function newBusiness(): Promise<string> {
  const [b] = await env.sql<{ id: string }[]>`INSERT INTO businesses (name) VALUES ('Billing Test') RETURNING id`;
  return b.id;
}
async function setSub(businessId: string, plan: string, status: string, pastDueSince: Date | null = null) {
  await env.sql`
    INSERT INTO subscriptions (business_id, plan, status, stripe_customer_id, past_due_since)
    VALUES (${businessId}, ${plan}, ${status}, 'cus_x', ${pastDueSince})
    ON CONFLICT (business_id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, past_due_since = EXCLUDED.past_due_since`;
}

describe("plan resolution", () => {
  it("is free with no subscription", async () => {
    expect((await getBusinessPlan(env.sql, env.ctx.businessId)).id).toBe("free");
  });

  it("uses an active or trialing paid subscription", async () => {
    const b = await newBusiness();
    await setSub(b, "pro", "active");
    expect((await getBusinessPlan(env.sql, b)).id).toBe("pro");
    await setSub(b, "founder", "trialing");
    expect((await getBusinessPlan(env.sql, b)).id).toBe("founder");
  });

  it("canceled and unpaid fall back to free", async () => {
    const b = await newBusiness();
    await setSub(b, "pro", "canceled");
    expect((await getBusinessPlan(env.sql, b)).id).toBe("free");
    await setSub(b, "pro", "unpaid");
    expect((await getBusinessPlan(env.sql, b)).id).toBe("free");
  });

  it("past_due keeps the paid plan for 7 days, then free", async () => {
    const b = await newBusiness();
    await setSub(b, "pro", "past_due", new Date(Date.now() - 6 * DAY));
    const inGrace = await currentUsageSummary(env.sql, b);
    expect(inGrace.plan.id).toBe("pro");
    expect(inGrace.pastDue).not.toBeNull();
    await setSub(b, "pro", "past_due", new Date(Date.now() - 8 * DAY));
    const after = await currentUsageSummary(env.sql, b);
    expect(after.plan.id).toBe("free");
    expect(after.graceExpired).toBe(true);
  });

  it("an override beats the subscription and merges limits; clearing it restores the subscription", async () => {
    const b = await newBusiness();
    await setSub(b, "founder", "active");
    await setPlanOverride(env.sql, b, "business", { aiRequestsPerMonth: 5 }, "pilot customer", "admin-1");
    const p = await getBusinessPlan(env.sql, b);
    expect(p.id).toBe("business");
    expect(p.limits.aiRequestsPerMonth).toBe(5);
    expect(p.limits.teamMembers).toBe(getPlan("business").limits.teamMembers);
    await clearPlanOverride(env.sql, b);
    expect((await getBusinessPlan(env.sql, b)).id).toBe("founder");
  });

  it("rejects an unknown plan or limit in an override", async () => {
    await expect(setPlanOverride(env.sql, env.ctx.businessId, "platinum", null, "x", "a")).rejects.toBeInstanceOf(HttpError);
    await expect(setPlanOverride(env.sql, env.ctx.businessId, "pro", { bogus: 1 }, "x", "a")).rejects.toBeInstanceOf(HttpError);
  });

  it("effectivePlan is pure and ignores a paid plan name with status none", () => {
    const sub = { plan: "pro", status: "none", past_due_since: null, updated_at: new Date() } as SubscriptionRow;
    expect(effectivePlan(sub, null).plan.id).toBe("free");
  });
});

describe("usage and quota", () => {
  it("counts monthly usage in the current calendar month only", async () => {
    const b = await newBusiness();
    await recordUsage(env.sql, { businessId: b, userId: "u", metric: "aiRequestsPerMonth", quantity: 3 });
    await env.sql`INSERT INTO usage_events (business_id, user_id, metric, quantity, created_at) VALUES (${b}, 'u', 'aiRequestsPerMonth', 50, now() - interval '40 days')`;
    expect(await usageThisPeriod(env.sql, b, "aiRequestsPerMonth")).toBe(3);
    expect(await usageThisPeriod(env.sql, b, "ai_request")).toBe(3); // alias
  });

  it("allows usage up to the limit and then throws a clear 402", async () => {
    const b = await newBusiness();
    const limit = getPlan("free").limits.aiRequestsPerMonth as number;
    await useQuota(env.sql, b, "u", "aiRequestsPerMonth", limit - 1);
    await useQuota(env.sql, b, "u", "ai_request"); // the last one
    expect(await usageThisPeriod(env.sql, b, "aiRequestsPerMonth")).toBe(limit);
    const err = await useQuota(env.sql, b, "u", "ai_request").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(402);
    expect(err.message).toContain("Free");
    expect(err.message).toContain("Founder"); // the plan that raises it
    expect(err.message).toContain(String(limit));
    expect(await usageThisPeriod(env.sql, b, "aiRequestsPerMonth")).toBe(limit); // nothing recorded on refusal
  });

  it("refuses a request that would exceed the limit as a whole", async () => {
    const b = await newBusiness();
    await expect(useQuota(env.sql, b, "u", "aiRequestsPerMonth", 21)).rejects.toMatchObject({ status: 402 });
  });

  it("never lets parallel calls exceed the limit", async () => {
    const b = await newBusiness();
    await setPlanOverride(env.sql, b, "free", { aiRequestsPerMonth: 5 }, "concurrency test", "admin");
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => useQuota(env.sql, b, "u", "ai_request")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(15);
    expect(rejected.every((r) => r.reason instanceof HttpError && r.reason.status === 402)).toBe(true);
    expect(await usageThisPeriod(env.sql, b, "aiRequestsPerMonth")).toBe(5);
  });

  it("unlimited plans are never blocked", async () => {
    const b = await newBusiness();
    await setSub(b, "business", "active");
    await useQuota(env.sql, b, "u", "aiRequestsPerMonth", 100000);
    expect(await usageThisPeriod(env.sql, b, "aiRequestsPerMonth")).toBe(100000);
  });

  it("metrics without a plan limit are just recorded", async () => {
    const b = await newBusiness();
    await useQuota(env.sql, b, "u", "input_tokens", 1234);
    expect(await usageThisPeriod(env.sql, b, "input_tokens")).toBe(1234);
  });

  it("stock metrics are checked against the real total, not recorded", async () => {
    const b = await newBusiness();
    await env.sql`INSERT INTO business_members (business_id, user_id, role) VALUES (${b}, 'owner-1', 'owner')`;
    expect(await usageThisPeriod(env.sql, b, "teamMembers")).toBe(1);
    // Free allows 1 team member, so adding one more is refused with a message naming the plan.
    const err = await useQuota(env.sql, b, "owner-1", "teamMembers", 1).catch((e) => e);
    expect(err).toMatchObject({ status: 402 });
    expect(err.message).toContain("team members");
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM usage_events WHERE business_id = ${b} AND metric = 'teamMembers'`;
    expect(n).toBe(0);
    await setSub(b, "founder", "active");
    await useQuota(env.sql, b, "owner-1", "teamMembers", 1); // Founder allows 2
  });

  it("storage in bytes converts to MB; missing tool tables count as 0", async () => {
    const b = await newBusiness();
    expect(await usageThisPeriod(env.sql, b, "storageMb")).toBe(0);
    await expect(useQuota(env.sql, b, "u", "storage_bytes", 10 * 1024 * 1024)).resolves.toBeUndefined(); // 10 MB of 50
    await expect(useQuota(env.sql, b, "u", "storage_bytes", 60 * 1024 * 1024)).rejects.toMatchObject({ status: 402 });
  });

  it("rejects negative amounts", async () => {
    await expect(useQuota(env.sql, env.ctx.businessId, "u", "ai_request", -1)).rejects.toMatchObject({ status: 400 });
  });
});

describe("usage summary and admin listing", () => {
  it("summarises plan, usage and limits for the billing page", async () => {
    const b = await newBusiness();
    await useQuota(env.sql, b, "u", "ai_request", 10);
    const s = await currentUsageSummary(env.sql, b);
    expect(s.plan.id).toBe("free");
    expect(s.source).toBe("free");
    const ai = s.usage.find((u) => u.metric === "aiRequestsPerMonth")!;
    expect(ai).toMatchObject({ used: 10, limit: 20, percent: 50, kind: "monthly" });
    const storage = s.usage.find((u) => u.metric === "storageMb")!;
    expect(storage.kind).toBe("stock");
    expect(s.usage.map((u) => u.metric)).toEqual(["aiRequestsPerMonth", "storageMb", "teamMembers", "competitors", "productRepos"]);
  });

  it("reports unlimited as a null limit and percent", async () => {
    const b = await newBusiness();
    await setSub(b, "business", "active");
    const s = await currentUsageSummary(env.sql, b);
    const ai = s.usage.find((u) => u.metric === "aiRequestsPerMonth")!;
    expect(ai.limit).toBeNull();
    expect(ai.percent).toBeNull();
  });

  it("listSubscriptions shows the effective plan, subscription and override", async () => {
    const b = await newBusiness();
    await setSub(b, "pro", "active");
    await setPlanOverride(env.sql, b, "business", null, "granted", "admin-9");
    const row = (await listSubscriptions(env.sql)).find((r) => r.businessId === b)!;
    expect(row).toMatchObject({ effectivePlan: "business", source: "override", subscriptionPlan: "pro", status: "active" });
    expect(row.override).toMatchObject({ plan: "business", reason: "granted", setBy: "admin-9" });
  });
});
