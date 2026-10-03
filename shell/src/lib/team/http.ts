import type { Failure } from "./members";

const STATUS: Record<string, number> = {
  forbidden: 403, owner_protected: 403, self: 400, unchanged: 400, last_owner: 409, role_not_allowed: 403, not_member: 404, not_found: 404, invalid: 400,
};

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export const failure = (f: Pick<Failure, "code" | "message">) => json({ error: f.message, code: f.code }, STATUS[f.code] ?? 400);

/**
 * CSRF guard for cookie-authenticated mutations: if the browser sent an Origin, it must match the Host we were called on.
 * (Requests without an Origin, such as server-to-server calls, carry no ambient browser cookies of the attacker's choosing.)
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
