import { legalUrl, provisionToken } from "@/lib/signup/config";

export interface LegalDeps {
  /** Injectable for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export interface LegalReply { status: number; json: Record<string, unknown> }

/**
 * Server-to-server call to LegalAI's private lifecycle endpoints (same token as signup). The token is sent only here and never logged.
 * Returns null when LegalAI cannot be reached or the token is not configured. Never throws.
 */
export async function legalCall(method: "POST" | "DELETE", path: string, body: unknown, deps: LegalDeps): Promise<LegalReply | null> {
  const env = deps.env ?? process.env;
  const token = provisionToken(env);
  if (token.length < 32) return null;
  try {
    const r = await (deps.fetch ?? fetch)(`${legalUrl(env)}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-internal-token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const json = ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    return { status: r.status, json };
  } catch {
    return null;
  }
}

export const userPath = (id: string, suffix = ""): string => `/api/internal/users/${encodeURIComponent(id)}${suffix}`;

/** LegalAI user ids are UUIDs; refuse anything else before it goes into a URL. */
export const isUserId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Look an address up. null = no such (active, or when includeInactive, unverified) account, or LegalAI unavailable. */
export async function lookupUser(email: string, deps: LegalDeps, includeInactive = false): Promise<string | null> {
  const r = await legalCall("POST", "/api/internal/users/lookup", { email, include_inactive: includeInactive }, deps);
  if (r?.status === 200 && isUserId(r.json.id)) return r.json.id;
  return null;
}
