import { getSession, type Session } from "@/lib/auth/server";
import { currentBusiness, type Business } from "@/lib/business";
import { csrfBlocked, jsonError } from "./http";

export interface MemberCall { session: Session; business: Business }

/** Signed-in member of their business. `roles` limits who may call (e.g. owner/admin for destructive actions); writes are also CSRF-checked. */
export async function memberApi(req: Request, opts: { write: boolean; roles?: string[] }): Promise<MemberCall | { response: Response }> {
  const session = await getSession();
  if (!session) return { response: jsonError("Not signed in", 401) };
  if (opts.write) {
    const blocked = csrfBlocked(req);
    if (blocked) return { response: blocked };
  }
  const business = await currentBusiness(session.user.id);
  if (!business) return { response: jsonError("No business", 404) };
  if (opts.roles && !opts.roles.includes(business.role)) return { response: jsonError("Only an owner or admin can do this", 403) };
  return { session, business };
}
