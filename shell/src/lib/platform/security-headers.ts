/**
 * Security headers in Next's `headers()` format. Wire into next.config.ts:
 *   import { securityHeaders } from "./src/lib/platform/security-headers";
 *   async headers() { return [{ source: "/(.*)", headers: securityHeaders() }]; }
 *
 * Content-Security-Policy (static, no nonce, so pages can stay cacheable; nonces need a proxy and fully dynamic rendering):
 *  - default-src 'self'            everything not listed below may only load from our own origin (no wildcards, no third-party hosts).
 *  - script-src 'self' 'unsafe-inline'   Next.js emits inline bootstrap/flight-data <script> tags; without a per-request nonce they need
 *                                  'unsafe-inline'. 'unsafe-eval' is added in development only (React dev tooling).
 *  - style-src 'self' 'unsafe-inline'    Tailwind output is a same-origin file, but Next and React inject inline <style>/style attributes.
 *  - img-src 'self' data: blob:    same-origin images, data: URIs (LegalAI's inline favicon, small inline icons), blob: previews.
 *  - font-src 'self' data:         self-hosted fonts only.
 *  - connect-src 'self'            fetch/XHR/EventSource only to the same origin (/api/*, and /legal-ui/* which the shell proxies).
 *  - frame-src 'self'              the shell embeds LegalAI through its same-origin proxy (/legal-ui); no third-party frames.
 *  - frame-ancestors 'self'        only same-origin pages may frame us (with X-Frame-Options SAMEORIGIN for older browsers).
 *  - object-src 'none', base-uri 'self', form-action 'self'   no plugins, no <base> hijack, forms only post to us.
 *  - no upgrade-insecure-requests  Railway only serves https, and this directive would break a local http test setup (it upgrades the LegalAI frame to https). HSTS (production) covers upgrades.
 * If a later feature needs an external origin (for example Stripe.js), add that single origin to the specific directive on purpose.
 */
export interface HeaderEntry { key: string; value: string }

export function contentSecurityPolicy(isDev = process.env.NODE_ENV === "development"): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ];
  return directives.join("; ");
}

export function securityHeaders(isDev = process.env.NODE_ENV === "development"): HeaderEntry[] {
  return [
    ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]),
    { key: "Content-Security-Policy", value: contentSecurityPolicy(isDev) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "SAMEORIGIN" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
  ];
}
