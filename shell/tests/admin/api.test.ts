import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import type { Session } from "@/lib/auth/server";
import type { AdminDeps } from "@/lib/admin/guard";
import {
  clearOverrideHandler, liftHandler, listSuspensionsHandler, revenueHandler, setOverrideHandler, suspendHandler, usageExportHandler, usageHandler,
} from "@/lib/admin/handlers";
import { isSuspended, liftSuspension } from "@/lib/admin/suspensions";
import { getBusinessPlan, resolvePlan } from "@/lib/billing";

let env: TestEnv;
let businessId: string;
const session = (id: string, role: string): Session => ({ user: { id, email: `${id}@example.test`, displayName: id, role } as Session["user"], cookie: "", csrf: "" });
const deps = (s: Session | null): AdminDeps => ({ getSession: async () => s, sql: () => env.sql });
const ADMIN = session("admtest-api-admin", "admin");
const USER = session("admtest-api-user", "user");
const TARGET = "admtest-api-target";

const req = (method: string, body?: unknown, url = "http://test/api/admin/x", headers: Record<string, string> = {}) =>
  new Request(url, { method, headers: { "content-type": "application/json", host: "test", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  env = await makeTestEnv([]);
  businessId = (await env.sql<{ id: string }[]>`INSERT INTO businesses (name) VALUES ('Admin API Co') RETURNING id`)[0].id;
});
afterAll(async () => {
  await liftSuspension(env.sql, TARGET);
  await env.sql`DELETE FROM platform_suspensions WHERE user_id LIKE 'admtest-api-%'`;
  await env.sql`DELETE FROM audit_events WHERE user_id LIKE 'admtest-api-%'`;
  await env.sql`DELETE FROM businesses WHERE id = ${businessId}`;
  await env.cleanup();
});

/** Every endpoint, called with a given session checker. */
const endpoints: [string, (d: AdminDeps) => Promise<Response>][] = [
  ["GET suspensions", (d) => listSuspensionsHandler(req("GET"), d)],
  ["POST suspend", (d) => suspendHandler(req("POST", { reason: "r" }), d, TARGET)],
  ["DELETE lift", (d) => liftHandler(req("DELETE", { reason: "r" }), d, TARGET)],
  ["PUT override", (d) => setOverrideHandler(req("PUT", { plan: "pro", reason: "r" }), d, businessId)],
  ["DELETE override", (d) => clearOverrideHandler(req("DELETE"), d, businessId)],
  ["GET revenue", (d) => revenueHandler(req("GET"), d)],
  ["GET usage", (d) => usageHandler(req("GET"), d)],
  ["GET usage export", (d) => usageExportHandler(req("GET"), d)],
];

describe("admin-only enforcement", () => {
  for (const [name, call] of endpoints) {
    it(`${name}: signed out and non-admin get 404, nothing changes`, async () => {
      expect((await call(deps(null))).status).toBe(404);
      expect((await call(deps(USER))).status).toBe(404);
      expect((await call(deps(session("admtest-api-owner", "owner")))).status).toBe(404);
      expect(await isSuspended(env.sql, TARGET)).toBe(false);
      expect((await resolvePlan(env.sql, businessId)).source).toBe("free");
    });
  }

  it("blocks cross-site writes even for an admin", async () => {
    const r = await suspendHandler(req("POST", { reason: "r" }, "http://test/x", { origin: "https://evil.example" }), deps(ADMIN), TARGET);
    expect(r.status).toBe(403);
    expect(await isSuspended(env.sql, TARGET)).toBe(false);
  });
});

describe("suspension API", () => {
  it("suspends with a reason, audits it, refuses self-suspension and missing reasons, then lifts", async () => {
    expect((await suspendHandler(req("POST", { reason: "" }), deps(ADMIN), TARGET)).status).toBe(400);
    expect((await suspendHandler(req("POST", { reason: "me" }), deps(ADMIN), ADMIN.user.id)).status).toBe(400);
    expect((await suspendHandler(req("POST", { reason: "spam" }), deps(ADMIN), TARGET)).status).toBe(200);
    expect(await isSuspended(env.sql, TARGET)).toBe(true);
    expect((await suspendHandler(req("POST", { reason: "spam" }), deps(ADMIN), TARGET)).status).toBe(409);
    const list = (await (await listSuspensionsHandler(req("GET", undefined, "http://test/a?active=1"), deps(ADMIN))).json()) as { suspensions: { userId: string }[] };
    expect(list.suspensions.some((s) => s.userId === TARGET)).toBe(true);

    expect((await liftHandler(req("DELETE", {}), deps(ADMIN), TARGET)).status).toBe(400); // reason required to lift too
    expect((await liftHandler(req("DELETE", { reason: "appeal accepted" }), deps(ADMIN), TARGET)).status).toBe(200);
    expect(await isSuspended(env.sql, TARGET)).toBe(false);
    expect((await liftHandler(req("DELETE", { reason: "again" }), deps(ADMIN), TARGET)).status).toBe(404);

    const audit = await env.sql<{ action: string }[]>`SELECT action FROM audit_events WHERE user_id = ${ADMIN.user.id} AND resource_id = ${TARGET} ORDER BY id`;
    expect(audit.map((a) => a.action)).toEqual(["admin.user.suspend", "admin.user.lift"]);
  });
});

describe("plan override API", () => {
  it("rejects bad input and unknown businesses", async () => {
    expect((await setOverrideHandler(req("PUT", { plan: "pro", reason: "" }), deps(ADMIN), businessId)).status).toBe(400);
    expect((await setOverrideHandler(req("PUT", { plan: "platinum", reason: "r" }), deps(ADMIN), businessId)).status).toBe(400);
    expect((await setOverrideHandler(req("PUT", { plan: "pro", reason: "r", limits: { bogus: 1 } }), deps(ADMIN), businessId)).status).toBe(400);
    expect((await setOverrideHandler(req("PUT", { plan: "pro", reason: "r", limits: { teamMembers: -1 } }), deps(ADMIN), businessId)).status).toBe(400);
    expect((await setOverrideHandler(req("PUT", { plan: "pro", reason: "r" }), deps(ADMIN), "not-a-uuid")).status).toBe(404);
    expect((await setOverrideHandler(req("PUT", { plan: "pro", reason: "r" }), deps(ADMIN), "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await resolvePlan(env.sql, businessId)).source).toBe("free");
  });

  it("sets an override with custom limits, shows the effective plan, audits, and clears", async () => {
    const r = await setOverrideHandler(req("PUT", { plan: "pro", limits: { teamMembers: 99, competitors: null }, reason: "design partner" }), deps(ADMIN), businessId);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, effectivePlan: "pro", source: "override" });
    const plan = await getBusinessPlan(env.sql, businessId);
    expect(plan.id).toBe("pro");
    expect(plan.limits.teamMembers).toBe(99);
    expect(plan.limits.competitors).toBeNull();
    expect(plan.limits.storageMb).toBe(10000); // untouched limits keep the plan value
    const resolved = await resolvePlan(env.sql, businessId);
    expect(resolved.override?.reason).toBe("design partner");
    expect(resolved.override?.set_by).toBe(ADMIN.user.id);

    // Replace it, then clear it.
    expect((await setOverrideHandler(req("PUT", { plan: "founder", reason: "downgrade" }), deps(ADMIN), businessId)).status).toBe(200);
    expect((await getBusinessPlan(env.sql, businessId)).id).toBe("founder");
    const c = await clearOverrideHandler(req("DELETE"), deps(ADMIN), businessId);
    expect(await c.json()).toMatchObject({ ok: true, effectivePlan: "free", source: "free" });

    const audit = await env.sql<{ action: string; meta: { plan?: string; reason?: string } }[]>`
      SELECT action, meta FROM audit_events WHERE business_id = ${businessId} AND user_id = ${ADMIN.user.id} AND action LIKE 'admin.plan_override.%' ORDER BY id`;
    expect(audit.map((a) => a.action)).toEqual(["admin.plan_override.set", "admin.plan_override.set", "admin.plan_override.clear"]);
    expect(audit[0].meta).toMatchObject({ plan: "pro", reason: "design partner" });
  });
});

describe("revenue and usage APIs", () => {
  it("return JSON for admins", async () => {
    const rev = (await (await revenueHandler(req("GET"), deps(ADMIN))).json()) as { estimated: boolean; summary: { mrr: number }; series: unknown[] };
    expect(rev.estimated).toBe(true);
    expect(typeof rev.summary.mrr).toBe("number");
    expect(rev.series).toHaveLength(6);
    const use = (await (await usageHandler(req("GET", undefined, "http://test/u?metric=admtest_none"), deps(ADMIN))).json()) as { totalEvents: number; tokens: number | null; costPercentOfEstimatedMrr: number | null };
    expect(use.totalEvents).toBe(0);
    expect(use.tokens).toBeNull();
    expect(use.costPercentOfEstimatedMrr).toBeNull();
  });

  it("exports CSV for admins only and audits the export", async () => {
    const res = await usageExportHandler(req("GET", undefined, "http://test/e?view=day&metric=admtest_none"), deps(ADMIN));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect((await res.text()).startsWith("day,events,quantity,estimated_cost_usd")).toBe(true);
    const [n] = await env.sql<{ n: string }[]>`SELECT count(*) AS n FROM audit_events WHERE user_id = ${ADMIN.user.id} AND action = 'admin.usage.export'`;
    expect(Number(n.n)).toBeGreaterThan(0);
  });
});
