import { db } from "@/lib/db";
import { csrfBlocked, jsonError } from "@/lib/platform/http";
import { clientIp, pruneAttempts } from "@/lib/signup/limits";
import { signup } from "@/lib/signup/service";

export const dynamic = "force-dynamic";

/** Self-serve signup. Public (no session). Origin-checked; rate limited per IP and per email in the service. Never logs the body. */
export async function POST(req: Request) {
  const blocked = csrfBlocked(req);
  if (blocked) return blocked;
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > 8192) return jsonError("Request too large", 413);
  const body = await req.json().catch(() => null);
  const sql = db();
  const r = await signup(body, { sql, ip: clientIp(req.headers) });
  if (Math.random() < 0.02) void pruneAttempts(sql);
  if (r.ok) return Response.json({ ok: true, next: r.next }, { headers: { "cache-control": "no-store" } });
  return Response.json({ error: r.message }, { status: r.status, headers: r.status === 429 ? { "retry-after": "3600" } : undefined });
}
