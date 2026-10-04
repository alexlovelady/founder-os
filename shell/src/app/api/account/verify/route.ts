import { accountPost } from "@/lib/lifecycle/http";
import { confirmVerification } from "@/lib/lifecycle/verify";

export const dynamic = "force-dynamic";

/** Public. Confirms an email address: `{ token }`. A POST (not a GET link) so a mail scanner that opens the link cannot use it up. */
export async function POST(req: Request) {
  return accountPost(req, async (sql, body, ip) => {
    const token = body && typeof body === "object" ? (body as { token?: unknown }).token : undefined;
    const r = await confirmVerification(sql, token, { ip });
    return r.ok ? { status: 200, body: { ok: true, next: r.next } } : { status: r.status, body: { error: r.message } };
  });
}
