import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { csvCell, parseUsageFilter, usageCsv, usageReport } from "@/lib/admin/usage";

let env: TestEnv;
let bizA: string;
let bizB: string;
const REQ = "admtest_requests";
const TOK = "admtest_tokens";
const DAY = 86_400_000;

beforeAll(async () => {
  env = await makeTestEnv([]);
  const mk = async (name: string) => (await env.sql<{ id: string }[]>`INSERT INTO businesses (name) VALUES (${name}) RETURNING id`)[0].id;
  bizA = await mk("Admin Usage A");
  bizB = await mk("Admin Usage B");
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);
  const ins = (b: string, metric: string, qty: number, cost: number | null, model: string | null, d: number) =>
    env.sql`INSERT INTO usage_events (business_id, metric, quantity, model, estimated_cost_usd, created_at) VALUES (${b}, ${metric}, ${qty}, ${model}, ${cost}, ${at(d)})`;
  await ins(bizA, REQ, 1, 0.5, "fast-m", 1);
  await ins(bizA, REQ, 1, 0.25, "fast-m", 1);
  await ins(bizA, REQ, 1, null, null, 3);
  await ins(bizB, REQ, 1, 1, "deep-m", 2);
  await ins(bizA, TOK, 1200, null, null, 1);
  await ins(bizB, REQ, 5, null, null, 60); // outside the default 30-day window
});
afterAll(async () => {
  await env.sql`DELETE FROM businesses WHERE id IN (${bizA}, ${bizB})`;
  await env.cleanup();
});

describe("parseUsageFilter", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it("defaults to the last 30 days including today", () => {
    const f = parseUsageFilter({}, now);
    expect(f.from.toISOString()).toBe("2026-09-16T00:00:00.000Z");
    expect(f.to.toISOString()).toBe("2026-10-16T00:00:00.000Z");
  });
  it("swaps reversed ranges, rejects bad dates, caps the range, trims the metric", () => {
    expect(parseUsageFilter({ from: "2026-10-10", to: "2026-10-01" }, now).from.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(parseUsageFilter({ from: "nope", to: "2026-02-30" }, now).to.toISOString().slice(0, 10)).toBe("2026-10-16");
    const capped = parseUsageFilter({ from: "2000-01-01", to: "2026-10-15" }, now);
    expect((capped.to.getTime() - capped.from.getTime()) / DAY).toBe(366);
    expect(parseUsageFilter({ metric: "  ai  " }, now).metric).toBe("ai");
    expect(parseUsageFilter({ metric: "   " }, now).metric).toBeNull();
  });
});

describe("usageReport with seeded usage_events", () => {
  it("aggregates by metric, business and day for a metric filter", async () => {
    const f = parseUsageFilter({ metric: REQ });
    const r = await usageReport(env.sql, f);
    expect(r.totalEvents).toBe(4);
    expect(r.requests).toBe(4);
    expect(r.tokens).toBeNull(); // no token metric in this filter
    expect(r.costUsd).toBeCloseTo(1.75);
    expect(r.costReported).toBe(true);
    expect(r.byMetric).toHaveLength(1);
    expect(r.byMetric[0]).toMatchObject({ metric: REQ, events: 4, eventsWithCost: 3, eventsWithModel: 3 });
    const names = r.byBusiness.map((b) => [b.businessName, b.events, b.costUsd]);
    expect(names).toEqual([["Admin Usage B", 1, 1], ["Admin Usage A", 3, 0.75]]);
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay.reduce((a, d) => a + d.events, 0)).toBe(4);
    expect(r.byDay.at(-1)?.day).toBe(r.to);
  });

  it("separates token metrics and reports tokens only when recorded", async () => {
    const tok = await usageReport(env.sql, parseUsageFilter({ metric: TOK }));
    expect(tok.tokens).toBe(1200);
    expect(tok.requests).toBe(0);
    expect(tok.costReported).toBe(false);
    expect(tok.byMetric[0].isTokenMetric).toBe(true);
  });

  it("honours the date range", async () => {
    const wide = await usageReport(env.sql, parseUsageFilter({ metric: REQ, from: new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10) }));
    expect(wide.requests).toBe(9);
    const narrow = await usageReport(env.sql, parseUsageFilter({ metric: REQ, from: new Date(Date.now() - 1 * DAY).toISOString().slice(0, 10) }));
    expect(narrow.requests).toBe(2);
  });
});

describe("CSV export", () => {
  it("escapes cells and neutralises formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("@x")).toBe("'@x");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
  });

  it("renders the metric table with blank cost when nothing reported one", async () => {
    const csv = usageCsv(await usageReport(env.sql, parseUsageFilter({ metric: TOK })), "metric");
    const [head, row] = csv.trim().split("\r\n");
    expect(head).toBe("metric,events,quantity,estimated_cost_usd,events_with_cost,events_with_model");
    expect(row).toBe(`${TOK},1,1200,,0,0`);
  });

  it("renders business and day views", async () => {
    const r = await usageReport(env.sql, parseUsageFilter({ metric: REQ }));
    expect(usageCsv(r, "business")).toContain("Admin Usage B");
    expect(usageCsv(r, "day").trim().split("\r\n")).toHaveLength(31);
  });
});
