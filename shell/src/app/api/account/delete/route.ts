import { getSession } from "@/lib/auth/server";
import { deleteAccount } from "@/lib/lifecycle/deletion";
import { accountPost } from "@/lib/lifecycle/http";
import { jsonError } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

/**
 * Delete the signed-in person's account (permanent). Needs the typed account email and the current password. Deliberately does not use
 * memberApi: a person with no business must still be able to finish a half-done deletion.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (!session) return jsonError("Not signed in", 401);
  const res = await accountPost(req, async (sql, body, ip) => {
    const r = await deleteAccount(sql, { id: session.user.id, email: session.user.email }, body, { ip });
    if (!r.ok) return { status: r.status, body: { error: r.message, ...(r.blockedBusinesses ? { blockedBusinesses: r.blockedBusinesses } : {}) } };
    // The LegalAI session is already revoked; also clear the cookie in this browser.
    return { status: 200, body: { deleted: true, ...r.summary }, headers: { "set-cookie": "legalai_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax" } };
  });
  return res;
}
