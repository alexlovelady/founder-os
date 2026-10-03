import { describe, expect, it } from "vitest";
import { checkOrigin, classifyRequest, clientKey, isWebhook, scaleForClient, trustsProxy, LIMITS } from "../../src/lib/ratelimit/classify";

const summary = (method: string, path: string) =>
  classifyRequest(method, path).map((r) => `${r.bucket}:${r.limit}/${r.windowMs / 1000}s`);

describe("classifyRequest (table)", () => {
  const cases: [string, string, string[]][] = [
    // pages and static assets are never limited
    ["GET", "/", []],
    ["GET", "/app/tasks", []],
    ["GET", "/pricing", []],
    ["GET", "/_next/static/chunks/a.js", []],
    ["GET", "/favicon.ico", []],
    ["POST", "/login", []],
    ["GET", "/legal-ui", []],
    ["GET", "/legal-ui/api/documents", []],
    ["POST", "/legal-ui/api/auth/logout", []],
    // general API
    ["GET", "/api/search", ["api:600/60s"]],
    ["GET", "/api/tools/crm/contacts", ["api:600/60s"]],
    ["HEAD", "/api/notifications/unread-count", ["api:600/60s"]],
    ["POST", "/api/tools/tasks/items", ["api-mutating:60/60s", "api:600/60s"]],
    ["PATCH", "/api/tools/tasks/items/123", ["api-mutating:60/60s", "api:600/60s"]],
    ["DELETE", "/api/business/abc", ["api-mutating:60/60s", "api:600/60s"]],
    ["PUT", "/api/privacy/settings", ["api-mutating:60/60s", "api:600/60s"]],
    ["post", "/api/links", ["api-mutating:60/60s", "api:600/60s"]],
    // trailing slash and case do not dodge a rule
    ["POST", "/API/Tools/Tasks/Items/", ["api-mutating:60/60s", "api:600/60s"]],
    // stripe webhook is excluded entirely
    ["POST", "/api/billing/webhook", []],
    ["POST", "/api/billing/webhook/", []],
    ["POST", "/API/billing/WEBHOOK", []],
    ["POST", "/api/billing/webhooks", ["api-mutating:60/60s", "api:600/60s"]],
    ["POST", "/api/billing/checkout", ["api-mutating:60/60s", "api:600/60s"]],
    // LegalAI sign-in
    ["POST", "/legal-ui/api/auth/login", ["login:10/60s"]],
    ["POST", "/legal-ui/api/auth/login/mfa", ["login:10/60s"]],
    ["POST", "/legal-ui/api/auth/login/", ["login:10/60s"]],
    ["GET", "/legal-ui/api/auth/me", []],
    // feedback and events
    ["POST", "/api/feedback", ["fe:/api/feedback:30/60s", "api-mutating:60/60s", "api:600/60s"]],
    ["POST", "/api/events", ["fe:/api/events:30/60s", "api-mutating:60/60s", "api:600/60s"]],
    // uploads
    ["POST", "/api/tools/vault/documents", ["upload:30/60s", "api-mutating:60/60s", "api:600/60s"]],
    ["POST", "/api/tools/vault/documents/8c1f/versions", ["upload:30/60s", "api-mutating:60/60s", "api:600/60s"]],
    ["GET", "/api/tools/vault/documents", ["api:600/60s"]],
    ["GET", "/api/tools/vault/documents/8c1f/download", ["api:600/60s"]],
    ["PATCH", "/api/tools/vault/documents/8c1f", ["api-mutating:60/60s", "api:600/60s"]],
    // prefix lookalikes are not special
    ["POST", "/apix/feedback", []],
    ["POST", "/api-docs", []],
  ];
  for (const [method, path, expected] of cases) {
    it(`${method} ${path}`, () => expect(summary(method, path)).toEqual(expected));
  }

  it("uses the documented numbers", () => {
    expect(LIMITS).toEqual({ general: 600, mutating: 60, login: 10, feedbackEvents: 30, upload: 30 });
  });
});

describe("isWebhook", () => {
  it.each([["/api/billing/webhook", true], ["/api/billing/webhook/", true], ["/api/billing/webhook/x", false], ["/api/billing", false]])("%s -> %s", (p, v) => expect(isWebhook(p)).toBe(v));
});

describe("client key", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
  it("is a single shared key when no proxy is trusted, even if a header is sent", () => {
    expect(clientKey(h({ "x-forwarded-for": "1.2.3.4" }), false)).toBe("unknown");
  });
  it("takes only the first hop of x-forwarded-for when trusted", () => {
    expect(clientKey(h({ "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" }), true)).toBe("203.0.113.9");
  });
  it("supports IPv6 and falls back to x-real-ip then unknown", () => {
    expect(clientKey(h({ "x-forwarded-for": "2001:DB8::1" }), true)).toBe("2001:db8::1");
    expect(clientKey(h({ "x-real-ip": "198.51.100.7" }), true)).toBe("198.51.100.7");
    expect(clientKey(h({}), true)).toBe("unknown");
  });
  it("rejects junk so a header cannot create unbounded or odd keys", () => {
    expect(clientKey(h({ "x-forwarded-for": "<script>alert(1)</script>" }), true)).toBe("unknown");
    expect(clientKey(h({ "x-forwarded-for": "a".repeat(500) }), true)).toBe("unknown");
  });
  it("gives the unknown key ten times the budget", () => {
    const scaled = scaleForClient(classifyRequest("POST", "/api/links"), "unknown");
    expect(scaled.map((r) => r.limit)).toEqual([600, 6000]);
    expect(scaleForClient(classifyRequest("POST", "/api/links"), "1.2.3.4").map((r) => r.limit)).toEqual([60, 600]);
  });
  it("trustsProxy reads RAILWAY and TRUST_PROXY", () => {
    expect(trustsProxy({})).toBe(false);
    expect(trustsProxy({ TRUST_PROXY: "true" })).toBe(true);
    expect(trustsProxy({ TRUST_PROXY: "false" })).toBe(false);
    expect(trustsProxy({ RAILWAY_ENVIRONMENT: "production" })).toBe(true);
    expect(trustsProxy({ RAILWAY: "1" })).toBe(true);
  });
});

describe("checkOrigin (table)", () => {
  const host = "app.example.com";
  const cases: { name: string; method: string; path: string; origin: string | null; host: string | null; cookie: string | null; ok: boolean }[] = [
    { name: "same-site POST", method: "POST", path: "/api/tools/tasks/items", origin: "https://app.example.com", host, cookie: "s=1", ok: true },
    { name: "same-site with port", method: "POST", path: "/api/links", origin: "http://localhost:3000", host: "localhost:3000", cookie: "s=1", ok: true },
    { name: "case-insensitive host", method: "DELETE", path: "/api/business/1", origin: "https://APP.example.com", host, cookie: "s=1", ok: true },
    { name: "cross-site POST", method: "POST", path: "/api/tools/tasks/items", origin: "https://evil.example", host, cookie: "s=1", ok: false },
    { name: "subdomain is not same", method: "POST", path: "/api/links", origin: "https://x.app.example.com", host, cookie: "s=1", ok: false },
    { name: "different port is not same", method: "PUT", path: "/api/links", origin: "http://app.example.com:8080", host, cookie: "s=1", ok: false },
    { name: "null origin", method: "POST", path: "/api/links", origin: "null", host, cookie: "s=1", ok: false },
    { name: "garbage origin", method: "POST", path: "/api/links", origin: "not a url", host, cookie: null, ok: false },
    { name: "origin but no host header", method: "POST", path: "/api/links", origin: "https://app.example.com", host: null, cookie: null, ok: false },
    { name: "missing origin, no cookie (curl/server)", method: "POST", path: "/api/links", origin: null, host, cookie: null, ok: true },
    { name: "missing origin, empty cookie", method: "POST", path: "/api/links", origin: null, host, cookie: "  ", ok: true },
    { name: "missing origin with cookie", method: "POST", path: "/api/links", origin: null, host, cookie: "session=abc", ok: false },
    { name: "empty origin with cookie", method: "PATCH", path: "/api/links", origin: "", host, cookie: "session=abc", ok: false },
    { name: "GET is never checked", method: "GET", path: "/api/search", origin: "https://evil.example", host, cookie: "s=1", ok: true },
    { name: "HEAD never checked", method: "HEAD", path: "/api/search", origin: "https://evil.example", host, cookie: "s=1", ok: true },
    { name: "OPTIONS never checked", method: "OPTIONS", path: "/api/links", origin: "https://evil.example", host, cookie: "s=1", ok: true },
    { name: "webhook exempt (Stripe has no Origin and no cookie, or any origin)", method: "POST", path: "/api/billing/webhook", origin: "https://evil.example", host, cookie: "s=1", ok: true },
    { name: "webhook with trailing slash exempt", method: "POST", path: "/api/billing/webhook/", origin: null, host, cookie: "s=1", ok: true },
    { name: "non-api path not checked", method: "POST", path: "/login", origin: "https://evil.example", host, cookie: "s=1", ok: true },
    { name: "LegalAI proxy path not checked", method: "POST", path: "/legal-ui/api/auth/login", origin: "https://evil.example", host, cookie: null, ok: true },
    { name: "lowercase method still checked", method: "post", path: "/api/links", origin: "https://evil.example", host, cookie: null, ok: false },
    { name: "mixed-case path still checked", method: "POST", path: "/API/links", origin: "https://evil.example", host, cookie: null, ok: false },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const r = checkOrigin({ method: c.method, pathname: c.path, origin: c.origin, host: c.host, cookie: c.cookie });
      expect(r.ok).toBe(c.ok);
      if (!c.ok) expect(r.reason).toBeTruthy();
    });
  }
});
