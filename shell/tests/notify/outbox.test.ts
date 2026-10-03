import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { backoffMs, disabledProvider, enqueueEmail, getEmailProvider, processOutbox, renderBriefEmail, renderNotificationEmail, resendProvider, type EmailMessage, type EmailProvider, type SendResult } from "../../src/lib/notify/email";

let env: TestEnv;
beforeAll(async () => { env = await makeTestEnv([]); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.sql`DELETE FROM email_outbox WHERE business_id = ${env.ctx.businessId}`; });

const fake = (results: SendResult[]) => {
  const sent: EmailMessage[] = [];
  const p: EmailProvider = { name: "fake", enabled: true, async send(m) { sent.push(m); return results.shift() ?? { ok: true }; } };
  return { p, sent };
};
const mail = { subject: "Hello", text: "t", html: "<p>t</p>" };
const row = async () => (await env.sql<{ status: string; attempts: number; last_error: string | null; next_attempt_at: Date }[]>`SELECT status, attempts, last_error, next_attempt_at FROM email_outbox WHERE business_id = ${env.ctx.businessId}`)[0];
const T0 = new Date("2026-10-07T12:00:00Z");

describe("outbox state machine", () => {
  it("sends a queued message once", async () => {
    await enqueueEmail(env.sql, env.ctx.businessId, "a@example.test", mail);
    const { p, sent } = fake([{ ok: true, id: "m1" }]);
    expect(await processOutbox(env.sql, { provider: p, now: T0 })).toMatchObject({ sent: 1 });
    expect(await processOutbox(env.sql, { provider: p, now: new Date(T0.getTime() + 86_400_000) })).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(1);
    expect((await row()).status).toBe("sent");
  });

  it("retries with exponential backoff, then fails after the max attempts", async () => {
    await enqueueEmail(env.sql, env.ctx.businessId, "a@example.test", mail);
    const { p } = fake(Array.from({ length: 10 }, () => ({ ok: false, error: "HTTP 503", retryable: true }) as SendResult));
    let now = T0;
    for (let i = 1; i <= 3; i++) {
      await processOutbox(env.sql, { provider: p, now, maxAttempts: 3 });
      const r = await row();
      if (i < 3) {
        expect(r).toMatchObject({ status: "queued", attempts: i, last_error: "HTTP 503" });
        expect(r.next_attempt_at.getTime()).toBe(now.getTime() + backoffMs(i));
        // Not due yet: nothing happens a minute later.
        expect(await processOutbox(env.sql, { provider: p, now: new Date(now.getTime() + 60_000), maxAttempts: 3 })).toMatchObject({ sent: 0, retried: 0, failed: 0 });
        now = r.next_attempt_at;
      }
    }
    expect(await row()).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("fails permanently on a non-retryable error", async () => {
    await enqueueEmail(env.sql, env.ctx.businessId, "a@example.test", mail);
    const { p } = fake([{ ok: false, error: "HTTP 422", retryable: false }]);
    expect(await processOutbox(env.sql, { provider: p, now: T0 })).toMatchObject({ failed: 1 });
    expect((await row()).status).toBe("failed");
  });

  it("two workers never send the same message", async () => {
    await enqueueEmail(env.sql, env.ctx.businessId, "a@example.test", mail);
    const { p, sent } = fake([]);
    await Promise.all([processOutbox(env.sql, { provider: p, now: T0 }), processOutbox(env.sql, { provider: p, now: T0 })]);
    expect(sent).toHaveLength(1);
  });

  it("with no provider configured it marks rows disabled and never claims to send", async () => {
    await enqueueEmail(env.sql, env.ctx.businessId, "a@example.test", mail);
    expect(getEmailProvider({})).toBe(disabledProvider);
    expect(await processOutbox(env.sql, { provider: disabledProvider, now: T0 })).toMatchObject({ disabled: 1, sent: 0 });
    expect(await row()).toMatchObject({ status: "disabled", last_error: "email disabled" });
  });
});

describe("backoff and providers", () => {
  it("doubles from 5 minutes and caps at 6 hours", () => {
    expect([1, 2, 3, 4].map(backoffMs)).toEqual([300_000, 600_000, 1_200_000, 2_400_000]);
    expect(backoffMs(20)).toBe(6 * 3_600_000);
  });

  it("uses Resend only when both env vars are set", () => {
    expect(getEmailProvider({ RESEND_API_KEY: "k" }).enabled).toBe(false);
    expect(getEmailProvider({ EMAIL_FROM: "a@b.test" }).enabled).toBe(false);
    expect(getEmailProvider({ RESEND_API_KEY: "k", EMAIL_FROM: "a@b.test" }).name).toBe("resend");
  });

  it("calls the Resend API with fetch and does not leak the response body in errors", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return calls.length === 1 ? new Response(JSON.stringify({ id: "re_1" }), { status: 200 }) : new Response("rejected someone@example.test", { status: 429 });
    }) as unknown as typeof fetch;
    const p = resendProvider("key123", "FounderOS <noreply@example.test>", f);
    expect(await p.send({ to: "x@example.test", ...mail, idempotencyKey: "id1" })).toEqual({ ok: true, id: "re_1" });
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer key123");
    const bad = await p.send({ to: "x@example.test", ...mail });
    expect(bad).toEqual({ ok: false, error: "Email provider returned HTTP 429", retryable: true });
  });

  it("escapes interpolated values in email html", () => {
    const m = renderNotificationEmail({ title: `<script>alert("x")</script>`, body: "a & b", href: "javascript:alert(1)" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
    expect(m.html).toContain("a &amp; b");
    expect(m.html).not.toContain("javascript:");
    expect(renderBriefEmail("s", "# Hi <b>\n- item <i>").html).not.toContain("<b>");
  });
});
