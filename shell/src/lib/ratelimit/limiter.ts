/**
 * Sliding-window rate limiter, in memory, no dependencies.
 *
 * Uses the "sliding window counter" approximation: each key keeps the hit count of the current fixed window and the previous one, and the
 * estimate is `prev * (1 - elapsedFraction) + cur`. Memory per key is constant (three numbers) however large the limit is.
 * Memory overall is bounded by `maxKeys`: expired keys are swept first, then the least recently used keys are evicted.
 *
 * Limits are per process. With several instances each one counts on its own (see docs/OPERATIONS.md).
 * Pure: the clock is injectable so tests do not sleep.
 */

export interface RateRule {
  /** Counter name. Rules with the same bucket and client share one counter. */
  bucket: string;
  /** Requests allowed per window. */
  limit: number;
  windowMs: number;
}

export interface RateResult {
  allowed: boolean;
  /** Seconds the client should wait before retrying (at least 1 when denied, 0 when allowed). */
  retryAfterSec: number;
  /** The rule that denied the request, when denied. */
  rule?: RateRule;
}

interface Entry {
  windowStart: number;
  cur: number;
  prev: number;
  windowMs: number;
}

export interface LimiterOptions {
  now?: () => number;
  /** Upper bound on tracked keys. Default 20000 (a few MB). */
  maxKeys?: number;
}

export class SlidingWindowLimiter {
  private entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(opts: LimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxKeys = Math.max(1, opts.maxKeys ?? 20_000);
  }

  /** Number of keys currently tracked (for tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }

  /** Roll the entry forward to the window that contains `t`. */
  private roll(e: Entry, t: number): void {
    const elapsed = t - e.windowStart;
    if (elapsed < e.windowMs) return;
    const windows = Math.floor(elapsed / e.windowMs);
    e.prev = windows === 1 ? e.cur : 0;
    e.cur = 0;
    e.windowStart += windows * e.windowMs;
  }

  private estimate(e: Entry, t: number): number {
    const fraction = (t - e.windowStart) / e.windowMs;
    return e.prev * (1 - fraction) + e.cur;
  }

  /** Time in seconds until the estimate for this entry drops below `limit` (assuming no further hits). */
  private retryAfter(e: Entry, t: number, limit: number): number {
    // A request is allowed when estimate <= limit - 1. Solve for the time analytically (no polling).
    const room = limit - 1;
    const untilWindowEnd = e.windowStart + e.windowMs - t;
    let waitMs: number;
    if (e.cur <= room) {
      // Within the current window: prev*(1-f) + cur <= room  =>  f >= 1 - (room - cur) / prev
      const needF = e.prev > 0 ? 1 - (room - e.cur) / e.prev : 0;
      waitMs = Math.max(0, needF * e.windowMs - (t - e.windowStart));
    } else {
      // The current window alone is over the limit: after it ends it becomes `prev` and decays: cur*(1-f') <= room
      const needF = 1 - room / e.cur;
      waitMs = untilWindowEnd + Math.max(0, needF) * e.windowMs;
    }
    return Math.max(1, Math.ceil(waitMs / 1000));
  }

  private touch(key: string, e: Entry): void {
    // Map keeps insertion order, so re-inserting marks the key as most recently used.
    this.entries.delete(key);
    this.entries.set(key, e);
  }

  private evictIfNeeded(t: number): void {
    if (this.entries.size < this.maxKeys) return;
    // 1) sweep everything that has been idle for two windows (it can no longer influence an estimate)
    for (const [k, e] of this.entries) {
      if (t - e.windowStart >= 2 * e.windowMs) this.entries.delete(k);
    }
    // 2) still full: drop the least recently used keys (front of the map) down to 90% of the cap
    if (this.entries.size >= this.maxKeys) {
      const target = Math.floor(this.maxKeys * 0.9);
      for (const k of this.entries.keys()) {
        if (this.entries.size <= target) break;
        this.entries.delete(k);
      }
    }
  }

  /**
   * Check every rule for this client and, only if ALL allow the request, count it against all of them.
   * A denied request is never counted, so a blocked client recovers as soon as its window slides.
   */
  consume(client: string, rules: RateRule[]): RateResult {
    const t = this.now();
    let worst: RateResult = { allowed: true, retryAfterSec: 0 };
    const live: { key: string; e: Entry; rule: RateRule }[] = [];
    for (const rule of rules) {
      const key = `${rule.bucket}|${client}`;
      let e = this.entries.get(key);
      if (!e) {
        this.evictIfNeeded(t);
        e = { windowStart: t, cur: 0, prev: 0, windowMs: rule.windowMs };
      } else {
        e.windowMs = rule.windowMs;
        this.roll(e, t);
      }
      live.push({ key, e, rule });
      if (this.estimate(e, t) + 1 > rule.limit) {
        const wait = this.retryAfter(e, t, rule.limit);
        if (worst.allowed || wait > worst.retryAfterSec) worst = { allowed: false, retryAfterSec: wait, rule };
      }
    }
    if (worst.allowed) {
      for (const { key, e } of live) {
        e.cur += 1;
        this.touch(key, e);
      }
    }
    return worst;
  }

  /** Forget everything (tests). */
  clear(): void {
    this.entries.clear();
  }
}
