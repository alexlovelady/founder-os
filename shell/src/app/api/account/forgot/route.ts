import { accountPost } from "@/lib/lifecycle/http";
import { requestPasswordReset } from "@/lib/lifecycle/reset";

export const dynamic = "force-dynamic";

/** Public. Always the same generic answer for a well-formed address (see requestPasswordReset). */
export async function POST(req: Request) {
  return accountPost(req, async (sql, body, ip) => {
    const r = await requestPasswordReset(sql, body, { ip });
    return r.ok ? { status: 200, body: { message: r.message, available: r.available } } : { status: r.status, body: { error: r.message } };
  });
}
