/**
 * Which rate-limit rules apply to a request, which client key to use, and the same-site (Origin) check.
 * Everything here is a pure function of its inputs so it can be tested as a table. `src/proxy.ts` is the thin glue.
 */
import type { RateRule } from "./limiter";

const MINUTE = 60_000;

export const LIMITS = {
  general: 600,
  mutating: 60,
  login: 10,
  feedbackEvents: 30,
  upload: 30,
} as const;

/**
 * Account lifecycle routes (password reset, email verification, account deletion). Strict per client IP, in addition to the general rules and
 * to the per-hashed-IP and per-hashed-email limits kept in the database (lib/lifecycle/limits.ts). Separate from LIMITS on purpose.
 */
const TEN_MINUTES = 10 * MINUTE;
export const ACCOUNT_LIMITS = { mail: 5, token: 10, sensitive: 5, admin: 20, page: 30 } as const;
const ACCOUNT_API: Record<string, RateRule> = {
  "/api/account/forgot": { bucket: "acct-mail", limit: ACCOUNT_LIMITS.mail, windowMs: TEN_MINUTES },
  "/api/account/resend-verification": { bucket: "acct-mail", limit: ACCOUNT_LIMITS.mail, windowMs: TEN_MINUTES },
  "/api/account/reset": { bucket: "acct-token", limit: ACCOUNT_LIMITS.token, windowMs: TEN_MINUTES },
  "/api/account/verify": { bucket: "acct-token", limit: ACCOUNT_LIMITS.token, windowMs: TEN_MINUTES },
  "/api/account/delete": { bucket: "acct-sensitive", limit: ACCOUNT_LIMITS.sensitive, windowMs: TEN_MINUTES },
  "/api/account/admin-reset-link": { bucket: "acct-admin", limit: ACCOUNT_LIMITS.admin, windowMs: TEN_MINUTES },
};
/** The public pages of the same flows. NOTE: src/proxy.ts only sees them if its matcher lists /forgot, /reset/:path* and /verify/:path*. */
const isAccountPage = (p: string): boolean => p === "/forgot" || p === "/verify" || p.startsWith("/reset/") || p.startsWith("/verify/");

/** Methods that change state. */
export const isMutating = (method: string): boolean => !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());

const stripTrailingSlash = (p: string): string => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

/** Stripe signs its own webhook; it must never be throttled or origin-checked. */
export const isWebhook = (pathname: string): boolean => stripTrailingSlash(pathname).toLowerCase() === "/api/billing/webhook";

const isApi = (p: string): boolean => p === "/api" || p.startsWith("/api/");
const LOGIN_PATHS = new Set(["/legal-ui/api/auth/login", "/legal-ui/api/auth/login/mfa"]);
const isUpload = (method: string, p: string): boolean =>
  method === "POST" && (p === "/api/tools/vault/documents" || /^\/api\/tools\/vault\/documents\/[^/]+\/versions$/.test(p));

/**
 * Rules for one request. All of them must allow it. An empty list means "not limited".
 * Pages and static assets are never limited; only /api/* and the two LegalAI login endpoints are.
 */
export function classifyRequest(method: string, rawPathname: string): RateRule[] {
  const m = method.toUpperCase();
  const p = stripTrailingSlash(rawPathname).toLowerCase();
  const rules: RateRule[] = [];

  if (LOGIN_PATHS.has(p)) {
    // One shared bucket for password and MFA step: guessing either is the same attack.
    return [{ bucket: "login", limit: LIMITS.login, windowMs: MINUTE }];
  }
  if (isAccountPage(p)) return [{ bucket: "acct-page", limit: ACCOUNT_LIMITS.page, windowMs: MINUTE }];
  if (!isApi(p) || isWebhook(p)) return rules;

  const acct = ACCOUNT_API[p];
  if (acct && isMutating(m)) rules.push(acct);
  if (p === "/api/feedback" || p === "/api/events") rules.push({ bucket: `fe:${p}`, limit: LIMITS.feedbackEvents, windowMs: MINUTE });
  if (isUpload(m, p)) rules.push({ bucket: "upload", limit: LIMITS.upload, windowMs: MINUTE });
  if (isMutating(m)) rules.push({ bucket: "api-mutating", limit: LIMITS.mutating, windowMs: MINUTE });
  rules.push({ bucket: "api", limit: LIMITS.general, windowMs: MINUTE });
  return rules;
}

/** Everything behind one unknown key shares the budget, so give it more room. */
export const UNKNOWN_CLIENT = "unknown";
export const UNKNOWN_CLIENT_MULTIPLIER = 10;

export const scaleForClient = (rules: RateRule[], client: string): RateRule[] =>
  client === UNKNOWN_CLIENT ? rules.map((r) => ({ ...r, limit: r.limit * UNKNOWN_CLIENT_MULTIPLIER })) : rules;

const truthy = (v: string | undefined): boolean => !!v && !["0", "false", "no", "off"].includes(v.toLowerCase());

/** True when the app sits behind a proxy whose forwarding headers can be believed (Railway, or the owner says so). */
export function trustsProxy(env: Record<string, string | undefined>): boolean {
  return truthy(env.TRUST_PROXY) || Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID || env.RAILWAY_SERVICE_ID || env.RAILWAY_ENVIRONMENT_ID) || truthy(env.RAILWAY);
}

const IP_CHARS = /^[0-9a-fA-F:.]{2,45}$/;

/**
 * The client key. Proxies cannot see the socket address in Next.js 16, so the only source is a forwarding header,
 * which is trustworthy only behind a proxy that sets it. Otherwise every request shares the key "unknown".
 */
export function clientKey(headers: { get(name: string): string | null }, trust: boolean): string {
  if (!trust) return UNKNOWN_CLIENT;
  const first = (headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() ?? "";
  if (IP_CHARS.test(first)) return first.toLowerCase();
  const real = (headers.get("x-real-ip") ?? "").trim();
  if (IP_CHARS.test(real)) return real.toLowerCase();
  return UNKNOWN_CLIENT;
}

export interface OriginCheckInput {
  method: string;
  pathname: string;
  origin: string | null;
  /** The host the request was sent to (Host header, or x-forwarded-host behind a trusted proxy). */
  host: string | null;
  cookie: string | null;
}

export interface OriginCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Same-site check for state-changing requests to the shell's own API (spec 37).
 *  - GET/HEAD/OPTIONS, non-/api paths and the Stripe webhook are not checked.
 *  - If an Origin header is present its host must equal the Host header ("null" origins are refused).
 *  - If Origin is missing the request is allowed only when it carries no cookie (a script or curl with no session cannot be a CSRF victim).
 */
export function checkOrigin(i: OriginCheckInput): OriginCheckResult {
  const p = stripTrailingSlash(i.pathname).toLowerCase();
  if (!isMutating(i.method) || !isApi(p) || isWebhook(p)) return { ok: true };
  if (i.origin !== null && i.origin !== "") {
    let originHost: string;
    try {
      originHost = new URL(i.origin).host.toLowerCase();
    } catch {
      return { ok: false, reason: "Origin is not a valid origin" };
    }
    if (!i.host) return { ok: false, reason: "Origin cannot be verified without a Host header" };
    if (originHost !== i.host.trim().toLowerCase()) return { ok: false, reason: "Origin does not match this site" };
    return { ok: true };
  }
  if (i.cookie && i.cookie.trim() !== "") return { ok: false, reason: "Missing Origin on a request that carries a session cookie" };
  return { ok: true };
}
