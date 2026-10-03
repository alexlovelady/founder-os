import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter, type RateRule } from "../../src/lib/ratelimit/limiter";

const rule = (limit: number, bucket = "b", windowMs = 60_000): RateRule => ({ bucket, limit, windowMs });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("SlidingWindowLimiter", () => {
  it("allows exactly `limit` requests per window then denies", () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ now: c.now });
    for (let i = 0; i < 5; i++) expect(l.consume("ip", [rule(5)]).allowed).toBe(true);
    const denied = l.consume("ip", [rule(5)]);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(120);
  });

  it("keeps clients and buckets separate", () => {
    const l = new SlidingWindowLimiter({ now: clock().now });
    expect(l.consume("a", [rule(1)]).allowed).toBe(true);
    expect(l.consume("a", [rule(1)]).allowed).toBe(false);
    expect(l.consume("b", [rule(1)]).allowed).toBe(true);
    expect(l.consume("a", [rule(1, "other")]).allowed).toBe(true);
  });

  it("recovers after the window slides and Retry-After is honest", () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ now: c.now });
    for (let i = 0; i < 10; i++) l.consume("ip", [rule(10)]);
    const denied = l.consume("ip", [rule(10)]);
    expect(denied.allowed).toBe(false);
    c.advance(denied.retryAfterSec * 1000);
    expect(l.consume("ip", [rule(10)]).allowed).toBe(true);
  });

  it("fully resets after two idle windows", () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ now: c.now });
    for (let i = 0; i < 3; i++) l.consume("ip", [rule(3)]);
    expect(l.consume("ip", [rule(3)]).allowed).toBe(false);
    c.advance(120_000);
    for (let i = 0; i < 3; i++) expect(l.consume("ip", [rule(3)]).allowed).toBe(true);
  });

  it("weights the previous window (sliding, not fixed)", () => {
    const c = clock(0);
    const l = new SlidingWindowLimiter({ now: c.now });
    for (let i = 0; i < 10; i++) expect(l.consume("ip", [rule(10)]).allowed).toBe(true);
    // 10% into the next window the previous window still counts ~90%: a burst at the boundary is NOT allowed to double
    c.advance(66_000);
    let ok = 0;
    for (let i = 0; i < 10; i++) if (l.consume("ip", [rule(10)]).allowed) ok++;
    expect(ok).toBeLessThan(5);
    expect(ok).toBeGreaterThanOrEqual(1);
  });

  it("does not count a denied request, and counts none of the rules when one denies", () => {
    const l = new SlidingWindowLimiter({ now: clock().now });
    const strict = rule(1, "strict");
    const loose = rule(100, "loose");
    expect(l.consume("ip", [strict, loose]).allowed).toBe(true);
    for (let i = 0; i < 50; i++) expect(l.consume("ip", [strict, loose]).allowed).toBe(false);
    // the loose bucket only saw the single allowed request, so 99 more are still allowed
    for (let i = 0; i < 99; i++) expect(l.consume("ip", [loose]).allowed).toBe(true);
    expect(l.consume("ip", [loose]).allowed).toBe(false);
  });

  it("reports the rule that denied and the longest wait", () => {
    const l = new SlidingWindowLimiter({ now: clock().now });
    const a = rule(1, "a", 10_000);
    const b = rule(1, "b", 60_000);
    l.consume("ip", [a, b]);
    const r = l.consume("ip", [a, b]);
    expect(r.allowed).toBe(false);
    expect(r.rule?.bucket).toBe("b");
    expect(r.retryAfterSec).toBeGreaterThan(10);
  });

  it("bounds memory: never exceeds maxKeys, evicts the least recently used", () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ now: c.now, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) {
      l.consume(`ip${i}`, [rule(5)]);
      expect(l.size).toBeLessThanOrEqual(100);
    }
    expect(l.size).toBeGreaterThan(0);
  });

  it("sweeps idle keys before evicting active ones", () => {
    const c = clock();
    const l = new SlidingWindowLimiter({ now: c.now, maxKeys: 50 });
    for (let i = 0; i < 49; i++) l.consume(`old${i}`, [rule(5)]);
    l.consume("active", [rule(1)]);
    expect(l.consume("active", [rule(1)]).allowed).toBe(false);
    c.advance(130_000);
    // all old keys and the active one are idle now; new traffic triggers the sweep
    for (let i = 0; i < 10; i++) l.consume(`new${i}`, [rule(5)]);
    expect(l.size).toBe(10);
  });

  it("an evicted key starts fresh (fails open, never throws)", () => {
    const l = new SlidingWindowLimiter({ now: clock().now, maxKeys: 2 });
    l.consume("a", [rule(1)]);
    l.consume("b", [rule(1)]);
    l.consume("c", [rule(1)]);
    expect(() => l.consume("a", [rule(1)])).not.toThrow();
  });

  it("clear() forgets everything", () => {
    const l = new SlidingWindowLimiter({ now: clock().now });
    l.consume("a", [rule(1)]);
    l.clear();
    expect(l.size).toBe(0);
    expect(l.consume("a", [rule(1)]).allowed).toBe(true);
  });
});
