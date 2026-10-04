import { describe, expect, it } from "vitest";
import { buildLogEntry, log } from "../../src/lib/ops/log";
import { sanitizeRoute, sanitizeText } from "../../src/lib/ops/sanitize";

describe("sanitizeText", () => {
  const cases: [string, string, string[]][] = [
    ["bearer header", "failed with Authorization: Bearer abcdef1234567890abcdef", ["abcdef1234567890"]],
    ["bearer token alone", "got Bearer eyJhbGciOi.payload.sig123", ["eyJhbGciOi"]],
    ["cookie header", "cookie: session=abc123; theme=dark", ["abc123"]],
    ["set-cookie", "set-cookie: founderos_session=zzzzzzzzzz; Path=/", ["zzzzzzzzzz"]],
    ["email", "user jane.doe+tag@example.co.uk not found", ["jane.doe", "example.co.uk"]],
    ["key=value password", "connect failed password=hunter2 host=db", ["hunter2"]],
    ["json secret", 'body {"api_key": "AAAAbbbbCCCC", "x": 1}', ["AAAAbbbbCCCC"]],
    ["token in query", "GET /api/x?token=abc123&y=2 failed", ["abc123", "y=2"]],
    ["database url", "could not connect to postgresql://legalai:s3cret@db.internal:5432/app", ["s3cret", "legalai:"]],
    ["stripe key", "bad key sk_live_51Habcdefghijklmnop", ["51Habcdef"]],
    ["openai style key", "sk-proj-abcdefghijklmnopqrstuvwx", ["abcdefghijklmnop"]],
    ["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", ["abcdefghijklmnop"]],
    ["aws key", "AKIAIOSFODNN7EXAMPLE leaked", ["AKIAIOSFODNN7EXAMPLE"]],
    ["jwt", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk", ["eyJhbGciOiJIUzI1NiJ9"]],
    ["long hex", "hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 mismatch", ["9f86d081884c7d65"]],
    ["private key", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", ["MIIEvQ"]],
    ["internal token header", "x-internal-token: 0123456789abcdef", ["0123456789abcdef"]],
  ];
  it.each(cases)("%s", (_name, input, gone) => {
    const out = sanitizeText(input);
    for (const g of gone) expect(out).not.toContain(g);
  });

  it("leaves ordinary messages readable", () => {
    expect(sanitizeText("Cannot read properties of undefined (reading 'map')")).toBe("Cannot read properties of undefined (reading 'map')");
    expect(sanitizeText("at Object.run (/app/shell/.next/server/chunks/ssr/page.js:12:34)")).toContain("page.js:12:34");
  });
  it("truncates", () => {
    const out = sanitizeText("a ".repeat(5000), 100);
    expect(out.length).toBeLessThan(130);
    expect(out).toContain("[truncated]");
  });
  it("handles non-strings", () => {
    expect(sanitizeText(null)).toBe("");
    expect(sanitizeText(42)).toBe("42");
  });
});

describe("sanitizeRoute", () => {
  it("drops the query string and ids", () => {
    expect(sanitizeRoute("/api/team/members?token=abc&x=1")).toBe("/api/team/members");
    expect(sanitizeRoute("/app/b/3f2c1a9e-1111-2222-3333-444455556666/files")).toBe("/app/b/:id/files");
    expect(sanitizeRoute("/x/123456")).toBe("/x/:id");
    expect(sanitizeRoute(undefined)).toBe("");
  });
});

describe("structured log", () => {
  it("writes one JSON line with level, event and allow-listed fields only", () => {
    const lines: string[] = [];
    log("info", "scheduled_job_ran", { job: "outbox", ok: true, body: { secret: "nope" }, userAgent: "x" }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    const o = JSON.parse(lines[0]);
    expect(o).toMatchObject({ level: "info", event: "scheduled_job_ran", job: "outbox", ok: true });
    expect(typeof o.ts).toBe("string");
    expect(o).not.toHaveProperty("body");
    expect(o).not.toHaveProperty("userAgent");
  });
  it("redacts secrets in values and nested keys, and emails", () => {
    const e = buildLogEntry("error", "x", { detail: "mail jane@example.com with Bearer abcdefghijklmnop", tables: { authorization: "Bearer zzzzzzzzzz", ok: 1 }, error: new Error("password=hunter22 failed") });
    const text = JSON.stringify(e);
    expect(text).not.toContain("jane@example.com");
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain("zzzzzzzzzz");
    expect(text).not.toContain("hunter22");
    expect(text).toContain("[redacted]");
  });
  it("never throws, even on circular input", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => log("info", "x", { detail: a }, () => { throw new Error("sink down"); })).not.toThrow();
  });
  it("respects LOG_LEVEL", () => {
    const lines: string[] = [];
    process.env.LOG_LEVEL = "error";
    try {
      log("info", "quiet", {}, (l) => lines.push(l));
      log("error", "loud", {}, (l) => lines.push(l));
    } finally {
      delete process.env.LOG_LEVEL;
    }
    expect(lines).toHaveLength(1);
  });
});
