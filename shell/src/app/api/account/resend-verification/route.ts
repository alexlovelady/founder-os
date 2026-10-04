import { accountPost } from "@/lib/lifecycle/http";
import { resendVerification } from "@/lib/lifecycle/verify";

export const dynamic = "force-dynamic";

/** Public. Generic answer whatever the address is. */
export async function POST(req: Request) {
  return accountPost(req, async (sql, body, ip) => {
    const r = await resendVerification(sql, body, { ip });
    return r.ok ? { status: 200, body: { message: r.message, available: r.available } } : { status: r.status, body: { error: r.message } };
  });
}
