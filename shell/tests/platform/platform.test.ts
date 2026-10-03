import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import type { ToolDef } from "@founderos/sdk";
import { listAudit, recordAudit, sanitizeAuditMeta, sanitizeMeta } from "@/lib/platform/audit";
import { decide, isEnabled, rolloutBucket, setOverride, upsertFlag, listFlags } from "@/lib/platform/flags";
import { eventCountsByDay, sanitizeProps, trackEvent } from "@/lib/platform/events";
import { cleanPage, FeedbackInput, RateLimitError, submitFeedback, listFeedback, setFeedbackStatus } from "@/lib/platform/feedback";
import { deleteBusiness, exportBusinessData, getPrivacySettings, memberRole, setPrivacySettings } from "@/lib/platform/privacy";
import { matchesPrefix } from "@/lib/platform/tables";
import { adminBusinessDetail, adminOverview, listBusinessesAdmin } from "@/lib/platform/admin";
import { sameOrigin } from "@/lib/platform/http";
import { contentSecurityPolicy, securityHeaders } from "@/lib/platform/security-headers";

// A stand-in tool with a secret column and a blob column, to prove the export leaves them out.
const fake: ToolDef = {
  id: "zzplat", name: "Platform test tool", description: "", group: "business", status: "planned",
  migrations: [{ name: "0001_x", sql: `CREATE TABLE zzplat_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    title text NOT NULL, api_token text, data bytea);
    CREATE TABLE zzplat_nobiz (id int PRIMARY KEY);` }],
};

describe("pure helpers", () => {
  it("strips secret-looking keys and truncates", () => {
    const m = sanitizeMeta({ name: "ok", password: "x", apiKey: "k", nested: { Authorization: "Bearer z", fine: 1 }, long: "a".repeat(1000), list: Array.from({ length: 50 }, (_, i) => i) }) as Record<string, unknown>;
    expect(m.password).toBeUndefined();
    expect(m.apiKey).toBeUndefined();
    expect((m.nested as Record<string, unknown>).Authorization).toBeUndefined();
    expect((m.nested as Record<string, unknown>).fine).toBe(1);
    expect((m.long as string).length).toBeLessThan(400);
    expect((m.list as unknown[]).length).toBe(20);
  });
  it("collapses oversized metadata", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) big[`k${i}`] = "x".repeat(290);
    expect(sanitizeAuditMeta(big)).toMatchObject({ truncated: true });
  });
  it("bucketing is deterministic, in range, and flag-specific", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(rolloutBucket(id, "a")).toBe(rolloutBucket(id, "a"));
    const buckets = new Set(Array.from({ length: 200 }, (_, i) => rolloutBucket(`b-${i}`, "a")));
    expect([...buckets].every((b) => b >= 0 && b < 100)).toBe(true);
    expect(buckets.size).toBeGreaterThan(40);
    let diff = 0;
    for (let i = 0; i < 50; i++) if (rolloutBucket(`b-${i}`, "a") !== rolloutBucket(`b-${i}`, "b")) diff++;
    expect(diff).toBeGreaterThan(30);
  });
  it("rollout percentage roughly matches and is monotonic", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `biz-${i}`);
    const on = (pct: number) => ids.filter((b) => decide({ enabled: true, rolloutPct: pct }, null, b, "k")).length;
    expect(on(0)).toBe(0);
    expect(on(100)).toBe(2000);
    expect(on(50)).toBeGreaterThan(850);
    expect(on(50)).toBeLessThan(1150);
    expect(on(30)).toBeLessThanOrEqual(on(60));
  });
  it("decide: override wins, disabled is off", () => {
    expect(decide({ enabled: false, rolloutPct: 100 }, true, "b", "k")).toBe(true);
    expect(decide({ enabled: true, rolloutPct: 100 }, false, "b", "k")).toBe(false);
    expect(decide({ enabled: false, rolloutPct: 100 }, null, "b", "k")).toBe(false);
    expect(decide(null, null, "b", "k")).toBe(false);
  });
  it("sanitizes event props", () => {
    expect(sanitizeProps({ tool: "crm", count: 3, ok: true, email: "a@b.c", message: "hi", nested: { a: 1 }, ["bad key"]: 1, long: "x".repeat(500) })).toEqual({ tool: "crm", count: 3, ok: true, long: "x".repeat(100) });
    expect(sanitizeProps("nope")).toEqual({});
  });
  it("feedback input and page cleaning", () => {
    expect(FeedbackInput.safeParse({ kind: "bug", message: "x".repeat(2001) }).success).toBe(false);
    expect(FeedbackInput.safeParse({ kind: "nope", message: "x" }).success).toBe(false);
    expect(FeedbackInput.safeParse({ kind: "bug", message: "  hello " }).data?.message).toBe("hello");
    expect(cleanPage("/app/t/crm?token=abc#x")).toBe("/app/t/crm");
  });
  it("prefix and origin checks", () => {
    expect(matchesPrefix("crm_contacts", ["crm"])).toBe(true);
    expect(matchesPrefix("crmx_items", ["crm"])).toBe(false);
    expect(matchesPrefix("billing", ["billing"])).toBe(true);
    expect(sameOrigin("https://a.com", "a.com")).toBe(true);
    expect(sameOrigin("https://evil.com", "a.com")).toBe(false);
    expect(sameOrigin(null, "a.com")).toBe(true);
    expect(sameOrigin("garbage", "a.com")).toBe(false);
  });
  it("security headers", () => {
    const h = Object.fromEntries(securityHeaders(false).map((x) => [x.key, x.value]));
    expect(h["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'self'");
    expect(h["Content-Security-Policy"]).not.toContain("*");
    expect(h["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy(true)).toContain("unsafe-eval");
  });
});

describe("database services", () => {
  let env: TestEnv;
  beforeAll(async () => { env = await makeTestEnv([fake]); });
  afterAll(async () => { await env.cleanup(); });

  it("audit: record, list, tenant scoped, never throws", async () => {
    const { sql, ctx, other } = env;
    await recordAudit(sql, { businessId: ctx.businessId, userId: ctx.userId, action: "test.action", resource: { tool: "crm", id: "1" }, meta: { token: "secret", ok: 1 } });
    await recordAudit(sql, { businessId: other.businessId, userId: other.userId, action: "test.other" });
    const rows = await listAudit(sql, ctx.businessId, { limit: 10 });
    expect(rows.map((r) => r.action)).toEqual(["test.action"]);
    expect(rows[0].meta).toEqual({ ok: 1 });
    await expect(recordAudit(sql, { businessId: "not-a-uuid", action: "x" })).resolves.toBeUndefined();
    await recordAudit(sql, { businessId: ctx.businessId, action: "test.second" });
    const page2 = await listAudit(sql, ctx.businessId, { limit: 10, before: rows[0].id });
    expect(page2).toEqual([]);
  });

  it("flags: seeded, override wins, unknown false, rollout", async () => {
    const { sql, ctx, other } = env;
    expect(await isEnabled(sql, "crm_enabled", ctx.businessId)).toBe(true);
    expect(await isEnabled(sql, "automations_enabled", ctx.businessId)).toBe(false);
    expect(await isEnabled(sql, "no_such_flag", ctx.businessId)).toBe(false);
    expect(await setOverride(sql, ctx.businessId, "automations_enabled", true)).toBe(true);
    expect(await isEnabled(sql, "automations_enabled", ctx.businessId)).toBe(true);
    expect(await isEnabled(sql, "automations_enabled", other.businessId)).toBe(false);
    await setOverride(sql, ctx.businessId, "automations_enabled", null);
    expect(await isEnabled(sql, "automations_enabled", ctx.businessId)).toBe(false);
    expect(await setOverride(sql, ctx.businessId, "missing_flag", true)).toBe(false);
    await upsertFlag(sql, { key: "plat_test_flag", description: "t", enabled: true, rolloutPct: 0 }, "admin");
    expect(await isEnabled(sql, "plat_test_flag", ctx.businessId)).toBe(false);
    await upsertFlag(sql, { key: "plat_test_flag", description: "t", enabled: true, rolloutPct: 100 }, "admin");
    expect(await isEnabled(sql, "plat_test_flag", ctx.businessId)).toBe(true);
    expect((await listFlags(sql)).some((f) => f.key === "plat_test_flag")).toBe(true);
    await sql`DELETE FROM feature_flags WHERE key = 'plat_test_flag'`;
  });

  it("analytics honors the opt-out and the allow-list", async () => {
    const { sql, ctx } = env;
    expect(await trackEvent(sql, { businessId: ctx.businessId, userId: ctx.userId, name: "calculator_used", props: { calculator: "price", email: "x@y.z" } })).toBe(true);
    expect(await trackEvent(sql, { businessId: ctx.businessId, userId: ctx.userId, name: "made_up_event" })).toBe(false);
    await setPrivacySettings(sql, ctx.businessId, ctx.userId, { aiDataUseNotes: "", allowProductAnalytics: false });
    expect(await trackEvent(sql, { businessId: ctx.businessId, userId: ctx.userId, name: "calculator_used" })).toBe(false);
    await setPrivacySettings(sql, ctx.businessId, ctx.userId, { aiDataUseNotes: "note", allowProductAnalytics: true });
    expect(await getPrivacySettings(sql, ctx.businessId)).toEqual({ aiDataUseNotes: "note", allowProductAnalytics: true });
    const [row] = await sql`SELECT props FROM analytics_events WHERE business_id = ${ctx.businessId} ORDER BY id DESC LIMIT 1`;
    expect(row.props).toEqual({ calculator: "price" });
    expect((await eventCountsByDay(sql, 7)).some((r) => r.name === "calculator_used")).toBe(true);
  });

  it("feedback: stored, rate limited at 10 per hour, status change", async () => {
    const { sql, ctx } = env;
    const who = { userId: `fb-${ctx.businessId}`, businessId: ctx.businessId };
    let first = 0;
    for (let i = 0; i < 10; i++) {
      const id = await submitFeedback(sql, who, { kind: "bug", message: `m${i}`, page: "/app?x=1" }, "UA");
      if (i === 0) first = id;
    }
    await expect(submitFeedback(sql, who, { kind: "other", message: "one more" }, "UA")).rejects.toBeInstanceOf(RateLimitError);
    // a different user is unaffected
    await expect(submitFeedback(sql, { userId: "someone-else", businessId: null }, { kind: "other", message: "hi" }, "UA")).resolves.toBeGreaterThan(0);
    const rows = await listFeedback(sql, { status: "new", limit: 500 });
    expect(rows.find((r) => r.id === first)?.page).toBe("/app");
    expect(await setFeedbackStatus(sql, first, "handled")).toBe(true);
    expect((await listFeedback(sql, { status: "handled" })).some((r) => r.id === first)).toBe(true);
    await sql`DELETE FROM feedback WHERE user_id IN (${who.userId}, 'someone-else')`;
  });

  it("export: includes tool rows, leaves out secrets and blobs, tenant scoped", async () => {
    const { sql, ctx, other } = env;
    await sql`INSERT INTO zzplat_items (business_id, title, api_token, data) VALUES (${ctx.businessId}, 'mine', 'tok', ${Buffer.from("bytes")})`;
    await sql`INSERT INTO zzplat_items (business_id, title) VALUES (${other.businessId}, 'theirs')`;
    const out = await exportBusinessData(sql, ctx.businessId, ["zzplat"]);
    const items = out.tools.zzplat.zzplat_items;
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("mine");
    expect(items[0]).not.toHaveProperty("api_token");
    expect(items[0]).not.toHaveProperty("data");
    expect(out.excludedColumns.zzplat_items.sort()).toEqual(["api_token", "data"]);
    expect(out.skippedTables).toContain("zzplat_nobiz");
    expect(out.business?.name).toBe("Test Co A");
    expect(out.members).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("theirs");
    expect(JSON.stringify(out)).not.toContain("tok\"");
  });

  it("delete business: owner only, name must match, cascades, audit survives", async () => {
    const { sql } = env;
    const mk = async (role: string) => {
      const [b] = await sql<{ id: string }[]>`INSERT INTO businesses (name) VALUES ('Doomed Inc') RETURNING id`;
      await sql`INSERT INTO business_members (business_id, user_id, role) VALUES (${b.id}, 'owner-x', 'owner'), (${b.id}, 'admin-x', ${role})`;
      await sql`INSERT INTO zzplat_items (business_id, title) VALUES (${b.id}, 'row')`;
      await recordAudit(sql, { businessId: b.id, userId: "owner-x", action: "x.y" });
      return b.id;
    };
    const id = await mk("admin");
    expect(await memberRole(sql, "admin-x", id)).toBe("admin");
    expect(await deleteBusiness(sql, { businessId: id, userId: "admin-x", confirmName: "Doomed Inc" })).toMatchObject({ ok: false, status: 403 });
    expect(await deleteBusiness(sql, { businessId: id, userId: "stranger", confirmName: "Doomed Inc" })).toMatchObject({ ok: false, status: 404 });
    expect(await deleteBusiness(sql, { businessId: id, userId: "owner-x", confirmName: "wrong" })).toMatchObject({ ok: false, status: 400 });
    expect(await deleteBusiness(sql, { businessId: id, userId: "owner-x", confirmName: " Doomed Inc " })).toEqual({ ok: true });
    expect(await sql`SELECT 1 FROM businesses WHERE id = ${id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM zzplat_items WHERE business_id = ${id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM audit_events WHERE business_id = ${id}`).toHaveLength(0);
    const ev = await sql`SELECT meta FROM audit_events WHERE action = 'privacy.business.delete' AND meta->>'deletedBusinessId' = ${id}`;
    expect(ev).toHaveLength(1);
    expect(JSON.stringify(ev[0].meta)).not.toContain("Doomed");
    await sql`DELETE FROM audit_events WHERE action = 'privacy.business.delete' AND meta->>'deletedBusinessId' = ${id}`;
  });

  it("admin queries: counts only, no row data", async () => {
    const { sql, ctx } = env;
    const o = await adminOverview(sql, ["zzplat"]);
    expect(o.businesses).toBeGreaterThanOrEqual(2);
    expect(o.users).toBeGreaterThanOrEqual(2);
    expect(o.toolRows.find((t) => t.table === "zzplat_items")).toBeTruthy();
    const list = await listBusinessesAdmin(sql, { search: "Test Co A" });
    expect(list.some((b) => b.id === ctx.businessId && b.members === 1 && b.ownerId === ctx.userId)).toBe(true);
    const d = await adminBusinessDetail(sql, ctx.businessId, ["zzplat"]);
    expect(d?.counts.find((c) => c.table === "zzplat_items")?.rows).toBe(1);
    expect(JSON.stringify(d)).not.toContain("mine");
    expect(await adminBusinessDetail(sql, "00000000-0000-0000-0000-000000000000", ["zzplat"])).toBeNull();
  });
});
