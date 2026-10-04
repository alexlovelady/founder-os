import { z } from "zod";
import { db } from "@/lib/db";
import { createAdminResetLink } from "@/lib/lifecycle/reset";
import { adminApi, jsonError } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

const Body = z.object({ userId: z.string().min(1).max(100) });

/**
 * Platform admin only (anyone else gets a 404). Creates a 24 hour, single-use password reset link for a user and returns it ONCE as a path;
 * only the hash is stored. The action is audited without the token. Hand the link to the person yourself, out of band.
 */
export async function POST(req: Request) {
  const a = await adminApi(req, { write: true });
  if ("response" in a) return a.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Missing user id", 400);
  const r = await createAdminResetLink(db(), { adminId: a.session.user.id, targetUserId: parsed.data.userId });
  if (!r.ok) return jsonError(r.message, r.status);
  return Response.json({ path: r.path, expiresAt: r.expiresAt }, { headers: { "cache-control": "no-store" } });
}
