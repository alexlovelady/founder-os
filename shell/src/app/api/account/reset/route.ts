import { accountPost } from "@/lib/lifecycle/http";
import { completeReset } from "@/lib/lifecycle/reset";

export const dynamic = "force-dynamic";

/** Public. Uses a reset link: `{ token, password }`. The token is single use; the password is never logged. */
export async function POST(req: Request) {
  return accountPost(req, async (sql, body, ip) => {
    const r = await completeReset(sql, body, { ip });
    return r.ok ? { status: 200, body: { ok: true, next: r.next } } : { status: r.status, body: { error: r.message } };
  });
}
