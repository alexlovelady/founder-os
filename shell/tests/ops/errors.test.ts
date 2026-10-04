import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { captureError, describeError, firstFrame, listErrors, purgeOldErrors, recordError, setResolved } from "../../src/lib/ops/errors";
import { buildEnvelope, forwardToSentry, parseDsn, type FetchLike } from "../../src/lib/ops/sentry";

let env: TestEnv;
beforeAll(async () => { env = await makeTestEnv([]); });
afterAll(async () => { await env.cleanup(); });
beforeEach(async () => { await env.sql`DELETE FROM error_events`; await env.sql`DELETE FROM scheduled_runs WHERE job = 'error_purge'`; });

const boom = (msg = "boom") => {
  const e = new Error(msg);
  e.stack = `Error: ${msg}\n    at handler (/app/shell/.next/server/app/api/x/route.js:10:5)\n    at next (/app/node_modules/next/dist/x.js:1:1)`;
  return e;
};

describe("fingerprint", () => {
  it("is stable across line numbers and ids, different across routes and messages", () => {
    const a = describeError(boom("user 123456 missing"), { route: "/api/x", method: "get" });
    const e2 = boom("user 987654 missing");
    e2.stack = e2.stack!.replace("10:5", "99:7");
    const b = describeError(e2, { route: "/api/x?y=1", method: "GET" });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.method).toBe("GET");
    expect(describeError(boom("user 123456 missing"), { route: "/api/y" }).fingerprint).not.toBe(a.fingerprint);
    expect(describeError(boom("other"), { route: "/api/x" }).fingerprint).not.toBe(a.fingerprint);
  });
  it("firstFrame drops line and column", () => expect(firstFrame("Error: x\n    at f (/a/b.js:3:4)")).toBe("at f (/a/b.js"));
  it("stores no secrets, no query string, and truncates", () => {
    const e = boom("failed for jane@example.com token=abc123 Bearer abcdefghijklmnop");
    e.stack += "\n    at /x?token=zzzzzz";
    const d = describeError(e, { route: "/api/z?token=secret" });
    const all = JSON.stringify(d);
    for (const bad of ["jane@example.com", "abc123", "abcdefghijklmnop", "zzzzzz", "secret"]) expect(all).not.toContain(bad);
    expect(describeError(boom("m".repeat(900))).message.length).toBeLessThanOrEqual(520);
    expect(describeError("string error").message).toBe("string error");
  });
});

describe("upsert", () => {
  it("counts repeats under one fingerprint and reopens a resolved group", async () => {
    const d = describeError(boom(), { route: "/api/x", method: "POST" });
    expect((await recordError(env.sql, d)).count).toBe(1);
    expect((await recordError(env.sql, d)).count).toBe(2);
    await recordError(env.sql, describeError(boom("different"), { route: "/api/x" }));
    const rows = await listErrors(env.sql, { status: "all" });
    expect(rows).toHaveLength(2);
    const g = rows.find((r) => r.message === "boom")!;
    expect(g.count).toBe(2);
    expect(await setResolved(env.sql, g.id, true)).toBe(true);
    expect(await listErrors(env.sql, { status: "open" })).toHaveLength(1);
    expect(await listErrors(env.sql, { status: "resolved" })).toHaveLength(1);
    await recordError(env.sql, d);
    expect(await listErrors(env.sql, { status: "resolved" })).toHaveLength(0);
    expect(await setResolved(env.sql, 999999999, true)).toBe(false);
  });

  it("captureError writes, never throws, and a broken database does not propagate", async () => {
    await captureError(boom("captured"), { route: "/job", method: "JOB" }, { sql: env.sql, env: {} });
    expect((await listErrors(env.sql, { status: "all" })).map((r) => r.message)).toEqual(["captured"]);
    const broken = (() => { throw new Error("db down"); }) as unknown as typeof env.sql;
    await expect(captureError(boom(), {}, { sql: broken, env: {} })).resolves.toBeUndefined();
    await expect(captureError(undefined, undefined, { sql: broken, env: {} })).resolves.toBeUndefined();
  });

  it("forwards to Sentry only when SENTRY_DSN is set", async () => {
    const calls: { url: string; body: string }[] = [];
    const fake: FetchLike = async (url, init) => { calls.push({ url, body: init.body }); return { ok: true, status: 200 }; };
    await captureError(boom("a"), { route: "/r" }, { sql: env.sql, env: {}, fetch: fake });
    expect(calls).toHaveLength(0);
    await captureError(boom("b"), { route: "/r" }, { sql: env.sql, env: { SENTRY_DSN: "https://pubkey@o1.ingest.sentry.io/42" }, fetch: fake });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://o1.ingest.sentry.io/api/42/envelope/");
  });
});

describe("retention purge", () => {
  it("deletes groups not seen for 90 days, keeps recent ones", async () => {
    const now = new Date("2026-10-04T00:00:00Z");
    await recordError(env.sql, describeError(boom("old"), { route: "/a" }), new Date("2026-06-01T00:00:00Z"));
    await recordError(env.sql, describeError(boom("edge"), { route: "/b" }), new Date("2026-07-10T00:00:00Z"));
    await recordError(env.sql, describeError(boom("new"), { route: "/c" }), new Date("2026-10-01T00:00:00Z"));
    expect(await purgeOldErrors(env.sql, now)).toBe(1);
    expect((await listErrors(env.sql, { status: "all" })).map((r) => r.message).sort()).toEqual(["edge", "new"]);
  });
});

describe("sentry forwarder", () => {
  it("parses DSNs", () => {
    expect(parseDsn("https://abc@o1.ingest.sentry.io/42")).toEqual({ endpoint: "https://o1.ingest.sentry.io/api/42/envelope/", publicKey: "abc" });
    expect(parseDsn("https://abc@host.example/prefix/7")?.endpoint).toBe("https://host.example/prefix/api/7/envelope/");
    expect(parseDsn("nonsense")).toBeNull();
    expect(parseDsn("https://host/42")).toBeNull();
    expect(parseDsn("https://abc@host/notanumber")).toBeNull();
  });
  it("builds a three-line envelope with the sanitized record only", () => {
    const rec = describeError(boom("secret thing jane@example.com"), { route: "/api/x?token=q", method: "POST" });
    const env3 = buildEnvelope("https://abc@h/1", rec, { now: new Date("2026-10-04T00:00:00Z"), eventId: "e".repeat(32) });
    const [h, item, body] = env3.split("\n");
    expect(JSON.parse(h)).toMatchObject({ event_id: "e".repeat(32) });
    expect(JSON.parse(item)).toMatchObject({ type: "event", length: Buffer.byteLength(body) });
    const ev = JSON.parse(body);
    expect(ev.exception.values[0].stacktrace.frames.length).toBe(2);
    expect(ev.fingerprint).toEqual([rec.fingerprint]);
    expect(env3).not.toContain("jane@example.com");
    expect(env3).not.toContain("token=q");
  });
  it("posts the envelope with the auth header, and swallows failures", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const ok: FetchLike = async (url, init) => { seen.push({ url, headers: init.headers }); return { ok: true, status: 200 }; };
    const rec = describeError(boom(), { route: "/r" });
    expect(await forwardToSentry("https://abc@o1.ingest.sentry.io/42", rec, { fetch: ok })).toBe(true);
    expect(seen[0].headers["x-sentry-auth"]).toContain("sentry_key=abc");
    expect(seen[0].headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(await forwardToSentry("https://abc@h/42", rec, { fetch: async () => { throw new Error("network"); } })).toBe(false);
    expect(await forwardToSentry("https://abc@h/42", rec, { fetch: async () => ({ ok: false, status: 429 }) })).toBe(false);
    expect(await forwardToSentry("bad dsn", rec, { fetch: ok })).toBe(false);
  });
});
