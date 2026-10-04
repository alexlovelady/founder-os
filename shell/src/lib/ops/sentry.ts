import { randomBytes } from "node:crypto";

/**
 * Optional Sentry forwarding without the SDK: one POST of an "envelope" to the project's ingest endpoint.
 * Enabled only when SENTRY_DSN is set. Only the already-sanitized record is sent (route, method, message, stack); no user, request or headers.
 * Failures are swallowed; a slow Sentry never delays a response for more than the timeout.
 */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface ParsedDsn {
  endpoint: string;
  publicKey: string;
}

/** DSN format: https://<public key>@<host>/<project id>  (a path prefix before the project id is allowed). */
export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    if (!/^https?:$/.test(u.protocol) || !u.username) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!project || !/^\d+$/.test(project)) return null;
    const prefix = parts.length ? `/${parts.join("/")}` : "";
    return { endpoint: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, publicKey: decodeURIComponent(u.username) };
  } catch {
    return null;
  }
}

export interface SentryRecord {
  fingerprint: string;
  route: string;
  method: string;
  message: string;
  stack: string;
}

/** The envelope body: header line, item header line, event JSON. Pure. */
export function buildEnvelope(dsn: string, rec: SentryRecord, opts: { now?: Date; environment?: string; release?: string; eventId?: string } = {}): string {
  const now = opts.now ?? new Date();
  const eventId = opts.eventId ?? randomBytes(16).toString("hex");
  const frames = rec.stack
    .split("\n")
    .filter((l) => /^\s*at\s/.test(l))
    .slice(0, 30)
    .map((l) => ({ function: l.trim().replace(/^at\s+/, "").slice(0, 200) }))
    .reverse();
  const event = {
    event_id: eventId,
    timestamp: now.getTime() / 1000,
    platform: "node",
    level: "error",
    environment: opts.environment ?? "production",
    ...(opts.release ? { release: opts.release } : {}),
    server_name: "founderos-shell",
    fingerprint: [rec.fingerprint],
    message: rec.message,
    transaction: rec.route,
    tags: { method: rec.method, route: rec.route },
    exception: { values: [{ type: "Error", value: rec.message, stacktrace: { frames } }] },
  };
  const body = JSON.stringify(event);
  return [JSON.stringify({ event_id: eventId, sent_at: now.toISOString(), dsn }), JSON.stringify({ type: "event", length: Buffer.byteLength(body) }), body].join("\n");
}

export async function forwardToSentry(dsn: string, rec: SentryRecord, opts: { fetch?: FetchLike; now?: Date; environment?: string; release?: string; timeoutMs?: number } = {}): Promise<boolean> {
  try {
    const parsed = parseDsn(dsn);
    if (!parsed) return false;
    const f = opts.fetch ?? (fetch as unknown as FetchLike);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 3000);
    try {
      const res = await f(parsed.endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_client=founderos-shell/1.0, sentry_key=${parsed.publicKey}` },
        body: buildEnvelope(dsn, rec, opts),
        signal: ctl.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
