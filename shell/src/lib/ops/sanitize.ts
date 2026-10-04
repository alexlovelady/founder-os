/**
 * Scrub text before it is stored, logged or forwarded: tokens, keys, cookies, emails, bearer headers, URL credentials and query strings.
 * Pure. Used for error messages and stacks (error_events, Sentry forwarding) and by the structured logger.
 */
const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private-key]"],
  [/\b(postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?|amqp|https?):\/\/[^\s/:@]+:[^\s/@]+@/gi, "$1://[credentials]@"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [redacted]"],
  [/\b(authorization|cookie|set-cookie|x-internal-token|x-backup-token|x-csrf-token)\s*[:=]\s*[^\n]*/gi, "$1=[redacted]"],
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|session|signature|dsn)\b(\s*["']?\s*[:=]\s*)(?!\[redacted\])("[^"]*"|'[^']*'|[^\s,;&)}\]]+)/gi, "$1$2[redacted]"],
  [/\b(sk|pk|rk|whsec)_(live|test)_[A-Za-z0-9]{8,}/g, "[stripe-key]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[api-key]"],
  [/\b(ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, "[github-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[aws-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[jwt]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // anything long and token-shaped that survived: 32+ hex, or 40+ base64url-ish characters
  [/\b[0-9a-fA-F]{32,}\b/g, "[hex]"],
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[long-token]"],
  // query strings in URLs and paths: "?a=b&c=d" up to whitespace, quote or paren
  [/\?[A-Za-z0-9_%.\-[\]]+=[^\s"')<>]*/g, "?[query]"],
];

export function sanitizeText(input: unknown, max = 4000): string {
  let s = typeof input === "string" ? input : input == null ? "" : String(input);
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

/** A route path without query string, hash, or ids that look like secrets (long opaque segments become ":id"). */
export function sanitizeRoute(path: unknown): string {
  const raw = typeof path === "string" ? path : "";
  const bare = raw.split("?")[0].split("#")[0].slice(0, 300);
  return bare
    .split("/")
    .map((seg) => (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg) || /^\d{4,}$/.test(seg) || seg.length > 40 ? ":id" : seg))
    .join("/");
}
