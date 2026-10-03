import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { createNotification, getPreferences, listNotifications, markAllRead, markRead, setPreferences, unreadCount } from "../../src/lib/notify";

let env: TestEnv;
beforeAll(async () => { env = await makeTestEnv([]); });
afterAll(async () => { await env.cleanup(); });

const A = () => env.ctx.businessId;
const B = () => env.other.businessId;
const U = () => env.ctx.userId;

describe("notifications", () => {
  it("is idempotent on dedupeKey and only counts one", async () => {
    const first = await createNotification(env.sql, A(), { title: "Annual report due", dedupeKey: "k1" }, { emailEnabled: false });
    const again = await createNotification(env.sql, A(), { title: "Annual report due", dedupeKey: "k1" }, { emailEnabled: false });
    expect(first.created).toBe(true);
    expect(again).toEqual({ id: null, created: false });
    const rows = await env.sql`SELECT 1 FROM notifications WHERE business_id = ${A()} AND dedupe_key = 'k1'`;
    expect(rows).toHaveLength(1);
  });

  it("allows the same key in different businesses and notifications without a key", async () => {
    expect((await createNotification(env.sql, B(), { title: "x", dedupeKey: "k1" }, { emailEnabled: false })).created).toBe(true);
    await createNotification(env.sql, A(), { title: "no key" }, { emailEnabled: false });
    expect((await createNotification(env.sql, A(), { title: "no key" }, { emailEnabled: false })).created).toBe(true);
  });

  it("isolates tenants and respects user targeting", async () => {
    await createNotification(env.sql, A(), { title: "Only for A user", dedupeKey: "t1" }, { userId: U(), emailEnabled: false });
    await createNotification(env.sql, A(), { title: "Someone else", dedupeKey: "t2" }, { userId: "another-user", emailEnabled: false });
    const mine = await listNotifications(env.sql, A(), U());
    const titles = mine.map((n) => n.title);
    expect(titles).toContain("Only for A user");
    expect(titles).not.toContain("Someone else");
    const theirs = await listNotifications(env.sql, B(), env.other.userId);
    expect(theirs.every((n) => n.title !== "Only for A user")).toBe(true);
    // Cross-tenant mark read does nothing.
    const [row] = await env.sql<{ id: string }[]>`SELECT id FROM notifications WHERE business_id = ${A()} AND dedupe_key = 'k1'`;
    expect(await markRead(env.sql, B(), env.other.userId, row.id)).toBe(false);
    expect(await markRead(env.sql, A(), U(), row.id)).toBe(true);
  });

  it("tracks unread and marks all read", async () => {
    const before = await unreadCount(env.sql, A(), U());
    expect(before).toBeGreaterThan(0);
    await markAllRead(env.sql, A(), U());
    expect(await unreadCount(env.sql, A(), U())).toBe(0);
    await createNotification(env.sql, A(), { title: "fresh", dedupeKey: "fresh" }, { emailEnabled: false });
    expect(await unreadCount(env.sql, A(), U())).toBe(1);
    expect((await listNotifications(env.sql, A(), U(), { unreadOnly: true })).map((n) => n.title)).toEqual(["fresh"]);
  });

  it("drops unsafe links and shortens long text instead of failing", async () => {
    await createNotification(env.sql, A(), { title: "t".repeat(500), href: "javascript:alert(1)", dedupeKey: "unsafe" }, { emailEnabled: false });
    const [r] = await env.sql<{ title: string; href: string | null }[]>`SELECT title, href FROM notifications WHERE business_id = ${A()} AND dedupe_key = 'unsafe'`;
    expect(r.href).toBeNull();
    expect(r.title).toHaveLength(200);
  });
});

describe("preferences and email queueing", () => {
  it("defaults to in-app on, email off", async () => {
    const p = await getPreferences(env.sql, A(), "nobody");
    expect(p).toMatchObject({ inApp: true, email: false, weeklyBrief: true, quietTypes: [], hasEmailAddress: false });
  });

  it("saves, validates and keeps the stored address when none is supplied", async () => {
    const p = await setPreferences(env.sql, A(), U(), { inApp: true, email: true, weeklyBrief: false, quietTypes: [] }, "owner@example.test");
    expect(p).toMatchObject({ email: true, weeklyBrief: false, hasEmailAddress: true });
    const p2 = await setPreferences(env.sql, A(), U(), { inApp: false, email: true, weeklyBrief: false, quietTypes: ["info"] });
    expect(p2).toMatchObject({ inApp: false, hasEmailAddress: true, quietTypes: ["info"] });
    await expect(setPreferences(env.sql, A(), U(), { inApp: "yes" })).rejects.toThrow();
    await setPreferences(env.sql, A(), U(), { inApp: true, email: true, weeklyBrief: false, quietTypes: [] });
  });

  it("hides the list when in-app is off", async () => {
    await setPreferences(env.sql, A(), U(), { inApp: false, email: true, weeklyBrief: false, quietTypes: [] });
    expect(await listNotifications(env.sql, A(), U())).toEqual([]);
    expect(await unreadCount(env.sql, A(), U())).toBe(0);
    await setPreferences(env.sql, A(), U(), { inApp: true, email: true, weeklyBrief: false, quietTypes: ["reminder"] });
  });

  it("queues email only for opted-in members, once, and respects quiet types and the email-enabled switch", async () => {
    const outbox = () => env.sql`SELECT subject, status FROM email_outbox WHERE business_id = ${A()}`;
    const n0 = (await outbox()).length;
    await createNotification(env.sql, A(), { title: "Due soon", dedupeKey: "compliance-due:1", severity: "review" }, { emailEnabled: true });
    expect(await outbox()).toHaveLength(n0 + 1);
    // Same key again: no second email.
    await createNotification(env.sql, A(), { title: "Due soon", dedupeKey: "compliance-due:1" }, { emailEnabled: true });
    expect(await outbox()).toHaveLength(n0 + 1);
    // Muted type.
    await createNotification(env.sql, A(), { title: "Muted", dedupeKey: "reminder:2" }, { emailEnabled: true });
    expect(await outbox()).toHaveLength(n0 + 1);
    // Email switched off at the platform level.
    await createNotification(env.sql, A(), { title: "No provider", dedupeKey: "compliance-due:3" }, { emailEnabled: false });
    expect(await outbox()).toHaveLength(n0 + 1);
    // Another business has no opted-in members.
    await createNotification(env.sql, B(), { title: "Other", dedupeKey: "compliance-due:1" }, { emailEnabled: true });
    expect(await env.sql`SELECT 1 FROM email_outbox WHERE business_id = ${B()}`).toHaveLength(0);
  });
});
