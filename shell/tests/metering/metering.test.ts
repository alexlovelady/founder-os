import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { setPlanOverride } from "@/lib/billing";
import { POST } from "@/app/api/internal/quota/consume/route";
import { activeBusinessId, consumeForUser, internalToken, parseConsumeBody, tokenMatches } from "@/lib/metering/consume";
import { fetchLegalUsage } from "@/lib/metering/legal-usage";
import { recordToolTokens, usageFromJob } from "@/lib/metering/tokens";
import { makeAiClient } from "@/lib/tools/ai";
import { toolTokensByModel, parseUsageFilter } from "@/lib/admin/usage";

const TOKEN = "m".repeat(40);
let env: TestEnv;
const created: string[] = [];
const users: string[] = [];

const mkBusiness = async (name: string, userId: string, createdAt?: Date) => {
  const [b] = await env.sql<{ id: string }[]>`INSERT INTO businesses (name, created_at) VALUES (${name}, ${createdAt ?? new Date()}) RETURNING id`;
  await env.sql`INSERT INTO business_members (business_id, user_id, role) VALUES (${b.id}, ${userId}, 'owner')`;
  created.push(b.id);
  return b.id;
};
const newUser = () => {
  const u = `meter-user-${Math.random().toString(36).slice(2)}`;
  users.push(u);
  return u;
};
const used = async (businessId: string, metric: string) =>
  Number((await env.sql<{ n: string }[]>`SELECT COALESCE(sum(quantity), 0) AS n FROM usage_events WHERE business_id = ${businessId} AND metric = ${metric}`)[0].n);

beforeAll(async () => {
  env = await makeTestEnv([]);
  (globalThis as { __sql?: unknown }).__sql = env.sql; // db() in the route returns the test connection
});
afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.INTERNAL_PROVISION_TOKEN;
  vi.unstubAllGlobals();
});
afterAll(async () => {
  if (created.length) await env.sql`DELETE FROM businesses WHERE id = ANY(${created})`;
  delete (globalThis as { __sql?: unknown }).__sql;
  await env.cleanup();
});

describe("token gate helpers", () => {
  it("tokenMatches is exact and rejects empty or different-length input", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN + "x", TOKEN)).toBe(false);
    expect(tokenMatches("é".repeat(40), TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
    expect(tokenMatches(null, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, "")).toBe(false);
  });
  it("internalToken is empty when unset or shorter than 32", () => {
    expect(internalToken({})).toBe("");
    expect(internalToken({ INTERNAL_PROVISION_TOKEN: "short" })).toBe("");
    expect(internalToken({ INTERNAL_PROVISION_TOKEN: ` ${TOKEN} ` })).toBe(TOKEN);
  });
});

describe("parseConsumeBody", () => {
  it("defaults amount to 1 and accepts only ai_request", () => {
    expect(parseConsumeBody({ userId: "u", metric: "ai_request" })).toEqual({ userId: "u", metric: "ai_request", amount: 1 });
    expect(() => parseConsumeBody({ userId: "u", metric: "storage_bytes" })).toThrow();
    expect(() => parseConsumeBody({ metric: "ai_request" })).toThrow();
    expect(() => parseConsumeBody({ userId: "u", metric: "ai_request", amount: 0 })).toThrow();
    expect(() => parseConsumeBody({ userId: "u", metric: "ai_request", amount: 1.5 })).toThrow();
    expect(() => parseConsumeBody("x")).toThrow();
  });
  it("never accepts a business id from the caller", () => {
    expect(() => parseConsumeBody({ userId: "u", metric: "ai_request", businessId: "b" })).toThrow();
  });
});

describe("consumeForUser", () => {
  it("allows and counts nothing for a user with no business", async () => {
    const r = await consumeForUser(env.sql, { userId: newUser(), metric: "ai_request" });
    expect(r).toEqual({ status: 200, body: { allowed: true, counted: false } });
  });

  it("picks the oldest business", async () => {
    const u = newUser();
    const older = await mkBusiness("Meter Older", u, new Date(Date.now() - 86_400_000 * 5));
    await mkBusiness("Meter Newer", u);
    expect(await activeBusinessId(env.sql, u)).toBe(older);
  });

  it("with Stripe off records one ai_request against the business and allows, even past plan limits", async () => {
    const u = newUser();
    const b = await mkBusiness("Meter Off", u);
    await setPlanOverride(env.sql, b, "free", { aiRequestsPerMonth: 1 }, "test", "admin");
    expect((await consumeForUser(env.sql, { userId: u, metric: "ai_request" })).status).toBe(200);
    expect((await consumeForUser(env.sql, { userId: u, metric: "ai_request", amount: 3 })).status).toBe(200);
    expect(await used(b, "aiRequestsPerMonth")).toBe(4);
  });

  it("with Stripe on enforces the plan and answers 402 with the plain message, recording nothing past the limit", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const u = newUser();
    const b = await mkBusiness("Meter On", u);
    await setPlanOverride(env.sql, b, "free", { aiRequestsPerMonth: 2 }, "test", "admin");
    expect((await consumeForUser(env.sql, { userId: u, metric: "ai_request" })).status).toBe(200);
    expect((await consumeForUser(env.sql, { userId: u, metric: "ai_request" })).status).toBe(200);
    const r = await consumeForUser(env.sql, { userId: u, metric: "ai_request" });
    expect(r.status).toBe(402);
    if (r.status === 402) {
      expect(r.body.allowed).toBe(false);
      expect(r.body.message).toMatch(/AI requests/i);
    }
    expect(await used(b, "aiRequestsPerMonth")).toBe(2);
  });
});

describe("POST /api/internal/quota/consume", () => {
  const call = (token: string | null, body: unknown) =>
    POST(new Request("http://x/api/internal/quota/consume", {
      method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-internal-token": token } : {}) },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));

  it("is 404 when the token is unset or short, even with a body", async () => {
    expect((await call(TOKEN, { userId: "u", metric: "ai_request" })).status).toBe(404);
    process.env.INTERNAL_PROVISION_TOKEN = "short";
    expect((await call("short", { userId: "u", metric: "ai_request" })).status).toBe(404);
  });

  it("is 401 without or with a wrong token", async () => {
    process.env.INTERNAL_PROVISION_TOKEN = TOKEN;
    expect((await call(null, { userId: "u", metric: "ai_request" })).status).toBe(401);
    expect((await call("w".repeat(40), { userId: "u", metric: "ai_request" })).status).toBe(401);
  });

  it("answers 400 for a bad body and counts for a valid one", async () => {
    process.env.INTERNAL_PROVISION_TOKEN = TOKEN;
    expect((await call(TOKEN, "not json")).status).toBe(400);
    expect((await call(TOKEN, { userId: "u", metric: "ai_request", businessId: "x" })).status).toBe(400);
    const u = newUser();
    const b = await mkBusiness("Meter Route", u);
    const ok = await call(TOKEN, { userId: u, metric: "ai_request" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ allowed: true, counted: true });
    expect(await used(b, "aiRequestsPerMonth")).toBe(1);
    const none = await call(TOKEN, { userId: newUser(), metric: "ai_request" });
    expect(await none.json()).toEqual({ allowed: true, counted: false });
  });

  it("returns 402 with the message when over the plan limit (Stripe on)", async () => {
    process.env.INTERNAL_PROVISION_TOKEN = TOKEN;
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const u = newUser();
    const b = await mkBusiness("Meter Route 402", u);
    await setPlanOverride(env.sql, b, "free", { aiRequestsPerMonth: 0 }, "test", "admin");
    const r = await call(TOKEN, { userId: u, metric: "ai_request" });
    expect(r.status).toBe(402);
    const j = await r.json();
    expect(j.allowed).toBe(false);
    expect(typeof j.message).toBe("string");
  });
});

describe("tool AI token recording", () => {
  it("records tokens once per job id (cost 0, model kept) and ignores repeats", async () => {
    const u = newUser();
    const b = await mkBusiness("Meter Tokens", u);
    const usage = { businessId: b, userId: u, jobId: "11111111-1111-1111-1111-111111111111", promptTokens: 100, completionTokens: 25, model: "fast-m" };
    expect(await recordToolTokens(env.sql, usage)).toBe(true);
    expect(await recordToolTokens(env.sql, usage)).toBe(false);
    expect(await recordToolTokens(env.sql, { ...usage, jobId: "22222222-2222-2222-2222-222222222222", promptTokens: 10, completionTokens: 0 })).toBe(true);
    expect(await used(b, "ai_tokens")).toBe(135);
    const [row] = await env.sql<{ model: string; cost: string; ext: string }[]>`SELECT model, estimated_cost_usd::text AS cost, external_id AS ext FROM usage_events WHERE business_id = ${b} AND external_id = 'job:11111111-1111-1111-1111-111111111111'`;
    expect(row).toEqual({ model: "fast-m", cost: "0", ext: "job:11111111-1111-1111-1111-111111111111" });
  });

  it("does not record empty usage, and the same job id in another business is separate", async () => {
    const b1 = await mkBusiness("Meter Tok A", newUser());
    const b2 = await mkBusiness("Meter Tok B", newUser());
    const base = { userId: null, jobId: "33333333-3333-3333-3333-333333333333", model: null };
    expect(await recordToolTokens(env.sql, { ...base, businessId: b1, promptTokens: 0, completionTokens: 0 })).toBe(false);
    expect(await recordToolTokens(env.sql, { ...base, businessId: b1, promptTokens: 5, completionTokens: 5 })).toBe(true);
    expect(await recordToolTokens(env.sql, { ...base, businessId: b2, promptTokens: 5, completionTokens: 5 })).toBe(true);
  });

  it("usageFromJob reads tokens and model from a LegalAI job", () => {
    expect(usageFromJob("j", { result: { prompt_tokens: 7, completion_tokens: 3, model: "deep-m" } })).toEqual({ jobId: "j", promptTokens: 7, completionTokens: 3, model: "deep-m" });
    expect(usageFromJob("j", { result: null, model_used: "m2" })).toEqual({ jobId: "j", promptTokens: 0, completionTokens: 0, model: "m2" });
  });

  it("the AI client reports usage when a polled job is complete, tolerates a failing callback, and sends the internal token on start", async () => {
    process.env.INTERNAL_PROVISION_TOKEN = TOKEN;
    const jobId = "44444444-4444-4444-4444-444444444444";
    const seen: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      if (url.endsWith("/api/inference")) return new Response(JSON.stringify({ id: jobId }), { status: 202 });
      return new Response(JSON.stringify({ state: "COMPLETE", result: { content: "<think>x</think>hello", prompt_tokens: 12, completion_tokens: 8, model: "fast-m" } }));
    });
    const onUsage = vi.fn().mockRejectedValue(new Error("db down"));
    const ai = makeAiClient({ user: { id: "u" }, cookie: "c=1", csrf: "t" } as never, "ws", onUsage);
    await ai.start({ prompt: "hi" });
    expect(seen[0].headers["x-internal-token"]).toBe(TOKEN);
    expect(await ai.poll(jobId)).toEqual({ state: "done", text: "hello" });
    expect(onUsage).toHaveBeenCalledWith({ jobId, promptTokens: 12, completionTokens: 8, model: "fast-m" });
    expect(seen[1].headers["x-internal-token"]).toBeUndefined();
  });
});

describe("admin and LegalAI usage", () => {
  it("toolTokensByModel groups ai_tokens by model", async () => {
    const b = await mkBusiness("Meter Admin", newUser());
    await recordToolTokens(env.sql, { businessId: b, userId: null, jobId: "55555555-5555-5555-5555-555555555555", promptTokens: 40, completionTokens: 2, model: "meter-model" });
    const rows = await toolTokensByModel(env.sql, parseUsageFilter({}));
    expect(rows.find((r) => r.model === "meter-model")?.tokens).toBe(42);
  });

  it("fetchLegalUsage returns null without a token, on errors, and parses a good answer", async () => {
    const since = new Date("2026-10-01T00:00:00Z");
    expect(await fetchLegalUsage(since, {})).toBeNull();
    const env1 = { INTERNAL_PROVISION_TOKEN: TOKEN, LEGAL_URL: "http://legal:8000/" };
    const bad = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchLegalUsage(since, env1, bad)).toBeNull();
    const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect(await fetchLegalUsage(since, env1, boom)).toBeNull();
    let sent = "";
    const good = (async (u: string, init: RequestInit) => {
      sent = `${u} ${(init.headers as Record<string, string>)["x-internal-token"]}`;
      return new Response(JSON.stringify({ since: since.toISOString(), requests: 3, prompt_tokens: 10, completion_tokens: 5, tokens: 15, cost_usd: 0 }));
    }) as unknown as typeof fetch;
    expect(await fetchLegalUsage(since, env1, good)).toMatchObject({ requests: 3, tokens: 15, costUsd: 0 });
    expect(sent).toContain("http://legal:8000/api/internal/usage?all=1&since=");
    expect(sent.endsWith(TOKEN)).toBe(true);
  });
});
