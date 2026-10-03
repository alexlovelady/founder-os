import type { Sql } from "@founderos/sdk";
import type { Session } from "@/lib/auth/server";

/**
 * Admin API plumbing with an injectable session checker so every endpoint's admin-only rule can be tested without cookies.
 * Route files pass `defaultDeps()` (lib/admin/deps.ts); tests pass a fake `getSession`.
 */
export interface AdminDeps {
  getSession: () => Promise<Session | null>;
  sql: () => Sql;
  now?: () => Date;
}

export const jsonError = (error: string, status: number) => Response.json({ error }, { status });

/** Same rule as lib/platform/http.sameOrigin: when an Origin header is sent it must match Host. */
export function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Admin session or a 404 response (the admin area never reveals itself). Writes also get the cross-site check. */
export async function requireAdmin(req: Request, deps: AdminDeps, write: boolean): Promise<{ session: Session } | { response: Response }> {
  const s = await deps.getSession();
  if (!s || s.user.role !== "admin") return { response: jsonError("Not found", 404) };
  if (write && !sameOrigin(req.headers.get("origin"), req.headers.get("host"))) return { response: jsonError("Cross-site request blocked", 403) };
  return { session: s };
}
