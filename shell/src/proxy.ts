import { NextResponse, type NextRequest } from "next/server";
import { checkOrigin, classifyRequest, clientKey, scaleForClient, trustsProxy } from "@/lib/ratelimit/classify";
import { SlidingWindowLimiter } from "@/lib/ratelimit/limiter";

/**
 * Request gate (Next.js 16 "proxy", formerly middleware). Runs before routes and before the /legal-ui rewrites.
 *  1. Same-site (Origin) check for state-changing requests to the shell's own /api/* (not the Stripe webhook).
 *  2. In-memory sliding-window rate limits per client IP (see lib/ratelimit/classify.ts for the table).
 * It only adds a decision; allowed requests pass straight through (`NextResponse.next()`), so streaming responses are untouched.
 * Limits are per server instance. See docs/OPERATIONS.md.
 */

declare global {
  var __rateLimiter: SlidingWindowLimiter | undefined;
}
const limiter = (globalThis.__rateLimiter ??= new SlidingWindowLimiter());
const TRUST = trustsProxy(process.env);

const noStore = { "cache-control": "no-store" };

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const method = req.method;

  // 1) CSRF / same-site check
  const host = req.headers.get("host");
  const forwardedHost = TRUST ? req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || null : null;
  const base = { method, pathname, origin: req.headers.get("origin"), cookie: req.headers.get("cookie") };
  const verdict = checkOrigin({ ...base, host });
  if (!verdict.ok && !(forwardedHost && checkOrigin({ ...base, host: forwardedHost }).ok)) {
    return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403, headers: noStore });
  }

  // 2) rate limits
  const client = clientKey(req.headers, TRUST);
  const rules = scaleForClient(classifyRequest(method, pathname), client);
  if (rules.length) {
    const res = limiter.consume(client, rules);
    if (!res.allowed) {
      return NextResponse.json(
        { error: "Too many requests. Please wait a moment and try again." },
        { status: 429, headers: { ...noStore, "retry-after": String(res.retryAfterSec) } },
      );
    }
  }
  return NextResponse.next();
}

// Pages and static assets never reach the proxy. The LegalAI login endpoints are matched explicitly because they live behind the /legal-ui rewrite.
export const config = {
  matcher: ["/api/:path*", "/legal-ui/api/auth/login", "/legal-ui/api/auth/login/mfa"],
};
