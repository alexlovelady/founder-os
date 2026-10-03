import { notFound } from "next/navigation";
import { getSession, type Session } from "@/lib/auth/server";

/** Reject cross-site browser requests to state-changing endpoints: when an Origin header is sent it must match the Host. Pure. */
export function sameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true; // non-browser clients and same-origin GETs do not send it; the session cookie is still required
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const jsonError = (error: string, status: number) => Response.json({ error }, { status });

export function csrfBlocked(req: Request): Response | null {
  return sameOrigin(req.headers.get("origin"), req.headers.get("host")) ? null : jsonError("Cross-site request blocked", 403);
}

/** Platform admin = LegalAI account with role "admin". Checked on the server from the verified session. */
export const isPlatformAdmin = (s: Session | null): s is Session => Boolean(s && s.user.role === "admin");

/** For admin pages: anyone else gets the normal 404 page (the admin area does not reveal itself). */
export async function requireAdminPage(): Promise<Session> {
  const s = await getSession();
  if (!isPlatformAdmin(s)) notFound();
  return s;
}

/** For admin API routes: returns the admin session or a 404 response. */
export async function adminApi(req: Request, opts: { write: boolean }): Promise<{ session: Session } | { response: Response }> {
  const s = await getSession();
  if (!isPlatformAdmin(s)) return { response: jsonError("Not found", 404) };
  if (opts.write) {
    const blocked = csrfBlocked(req);
    if (blocked) return { response: blocked };
  }
  return { session: s };
}
