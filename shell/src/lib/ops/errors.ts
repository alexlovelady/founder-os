import { createHash } from "node:crypto";
import type { Sql } from "@founderos/sdk";
import { log } from "./log";
import { sanitizeRoute, sanitizeText } from "./sanitize";
import { forwardToSentry, type FetchLike } from "./sentry";

/**
 * First-party error capture (spec 47, in lieu of Sentry). Errors are grouped by a fingerprint (route + message + first stack frame) and counted.
 * Stored: route (no query string), method, sanitized message (500) and stack (4000), counts and timestamps. Nothing about the user or the request body.
 * What it does NOT capture: errors in the browser (client components, failed fetches), errors the app catches and handles, and anything
 * that kills the process before the handler runs. Server render, route handler and server action errors reach it through `onRequestError`
 * in instrumentation.ts; background jobs reach it through captureError.
 */
export interface ErrorContext {
  route?: string;
  method?: string;
  status?: number | string;
}

export interface CapturedError {
  fingerprint: string;
  route: string;
  method: string;
  message: string;
  stack: string;
}

const normalizeMessage = (m: string) => m.replace(/\d{3,}/g, "N");

/** The first "at ..." frame of a stack with line and column numbers removed (they change on every deploy). */
export function firstFrame(stack: string): string {
  const line = stack.split("\n").find((l) => /^\s*at\s/.test(l)) ?? "";
  return line.trim().replace(/:\d+(:\d+)?\)?$/, "").replace(/\?[^\s)]*/, "");
}

/** Pure: turn whatever was thrown into the sanitized record that is stored. */
export function describeError(err: unknown, ctx: ErrorContext = {}): CapturedError {
  const e = err instanceof Error ? err : null;
  const rawMessage = e ? e.message : typeof err === "string" ? err : typeof err === "object" && err ? (() => { try { return JSON.stringify(err); } catch { return "non-serializable error"; } })() : String(err);
  const digest = typeof err === "object" && err && "digest" in err ? String((err as { digest: unknown }).digest) : "";
  const message = sanitizeText(rawMessage || e?.name || "Unknown error", 500);
  const stack = sanitizeText(e?.stack ?? "", 4000);
  const route = sanitizeRoute(ctx.route);
  const method = (ctx.method ?? "").toUpperCase().slice(0, 10);
  const fingerprint = createHash("sha256").update([route, normalizeMessage(message), firstFrame(stack) || digest].join("\u0000")).digest("hex").slice(0, 32);
  return { fingerprint, route, method, message, stack };
}

/** Insert or count++ by fingerprint. A resolved error that happens again reopens. */
export async function recordError(sql: Sql, d: CapturedError, now = new Date()): Promise<{ count: number }> {
  const [row] = await sql<{ count: number }[]>`
    INSERT INTO error_events (fingerprint, route, method, message, stack, first_seen, last_seen)
    VALUES (${d.fingerprint}, ${d.route}, ${d.method}, ${d.message}, ${d.stack}, ${now}, ${now})
    ON CONFLICT (fingerprint) DO UPDATE
      SET count = error_events.count + 1, last_seen = ${now}, message = EXCLUDED.message, stack = EXCLUDED.stack,
          status = 'open', resolved_at = NULL
    RETURNING count`;
  return { count: row.count };
}

export interface CaptureDeps {
  sql?: Sql;
  fetch?: FetchLike;
  env?: Record<string, string | undefined>;
  now?: Date;
}

/**
 * Record an error. Never throws and does not block the caller beyond the write: any failure is swallowed (and logged without payload).
 * Also forwards a sanitized event to Sentry when SENTRY_DSN is set.
 */
export async function captureError(err: unknown, ctx: ErrorContext = {}, deps: CaptureDeps = {}): Promise<void> {
  try {
    const d = describeError(err, ctx);
    const env = deps.env ?? process.env;
    try {
      const sql = deps.sql ?? (await import("../db")).db();
      await recordError(sql, d, deps.now);
    } catch {
      log("error", "error_capture_failed", { reason: "database write failed" });
    }
    if (env.SENTRY_DSN) await forwardToSentry(env.SENTRY_DSN, d, { fetch: deps.fetch, now: deps.now, environment: env.NODE_ENV, release: env.RAILWAY_GIT_COMMIT_SHA });
    log("error", "server_error", { fingerprint: d.fingerprint, route: d.route, method: d.method, error: d.message, status: ctx.status ?? null });
  } catch {
    /* never throw from an error handler */
  }
}

export interface ErrorGroup {
  id: number;
  fingerprint: string;
  route: string;
  method: string;
  message: string;
  stack: string;
  status: "open" | "resolved";
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export async function listErrors(sql: Sql, opts: { status?: "open" | "resolved" | "all"; limit?: number } = {}): Promise<ErrorGroup[]> {
  const status = opts.status ?? "open";
  const rows = await sql<{ id: string; fingerprint: string; route: string; method: string; message: string; stack: string; status: "open" | "resolved"; count: number; first_seen: Date; last_seen: Date }[]>`
    SELECT id, fingerprint, route, method, message, stack, status, count, first_seen, last_seen FROM error_events
    WHERE ${status === "all" ? sql`true` : sql`status = ${status}`}
    ORDER BY last_seen DESC LIMIT ${Math.min(opts.limit ?? 200, 500)}`;
  return rows.map((r) => ({ id: Number(r.id), fingerprint: r.fingerprint, route: r.route, method: r.method, message: r.message, stack: r.stack, status: r.status, count: r.count, firstSeen: r.first_seen.toISOString(), lastSeen: r.last_seen.toISOString() }));
}

export async function setResolved(sql: Sql, id: number, resolved: boolean): Promise<boolean> {
  const r = await sql`UPDATE error_events SET status = ${resolved ? "resolved" : "open"}, resolved_at = ${resolved ? new Date() : null} WHERE id = ${id} RETURNING id`;
  return r.length === 1;
}

export const ERROR_RETENTION_DAYS = 90;

/** Delete groups not seen for `days` days. Returns how many were removed. */
export async function purgeOldErrors(sql: Sql, now = new Date(), days = ERROR_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const r = await sql`DELETE FROM error_events WHERE last_seen < ${cutoff} RETURNING id`;
  return r.length;
}
