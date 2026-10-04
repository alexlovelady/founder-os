import { sanitizeText } from "./sanitize";

/**
 * Structured logging (spec 48): one JSON object per line on stdout, so Railway's log search can filter on fields.
 * Only allow-listed fields are written (anything else is dropped, not guessed at), keys that look like secrets are redacted,
 * and string values are scrubbed of emails, tokens and URL credentials. Never throws.
 */
export type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Fields a log line may carry. Add to this list deliberately: it is the privacy boundary of the logs. */
export const ALLOWED_FIELDS = new Set([
  "job", "ok", "detail", "ran", "locked", "durationMs", "count", "status", "route", "method", "fingerprint", "error", "errorName",
  "file", "sizeBytes", "verified", "restoreVerified", "kept", "pruned", "tables", "reason", "step", "businessId", "requestId", "migrations", "purged",
]);
const SENSITIVE_KEY = /pass(word|wd|phrase)?|token|secret|key|authorization|cookie|credential|session|csrf|bearer|signature|email|dsn/i;

function clean(value: unknown, depth = 0): unknown {
  if (value == null) return null;
  if (typeof value === "string") return sanitizeText(value, 500);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeText(value.message, 500);
  if (depth >= 2) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : clean(v, depth + 1);
    return out;
  }
  return null;
}

/** The sanitized object that would be written. Pure; exported for tests. */
export function buildLogEntry(level: Level, event: string, fields: Record<string, unknown> = {}, now = new Date()): Record<string, unknown> {
  const entry: Record<string, unknown> = { ts: now.toISOString(), level, event: sanitizeText(event, 120) };
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(k)) continue;
    entry[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : k === "fingerprint" && typeof v === "string" && /^[0-9a-f]{32}$/.test(v) ? v : clean(v);
  }
  return entry;
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}, write: (line: string) => void = (l) => process.stdout.write(l + "\n")): void {
  try {
    const min = ORDER[(process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : "info"];
    if (ORDER[level] < min) return;
    write(JSON.stringify(buildLogEntry(level, event, fields)));
  } catch {
    /* logging must never break the caller */
  }
}
