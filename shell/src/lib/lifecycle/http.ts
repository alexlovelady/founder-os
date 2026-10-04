import { db } from "@/lib/db";
import { csrfBlocked, jsonError } from "@/lib/platform/http";
import { clientIp } from "@/lib/signup/limits";

const noStore = { "cache-control": "no-store" };

/**
 * Shared front of the public account routes: same-origin check, a small body cap, JSON parse (never logged), then the handler.
 * The client IP comes from the trusted end of X-Forwarded-For (see clientIp). Bodies, tokens and passwords are never logged.
 */
export async function accountPost(
  req: Request,
  handler: (sql: ReturnType<typeof db>, body: unknown, ip: string) => Promise<{ status: number; body: Record<string, unknown>; headers?: Record<string, string> }>,
): Promise<Response> {
  const blocked = csrfBlocked(req);
  if (blocked) return blocked;
  if (Number(req.headers.get("content-length") ?? 0) > 8192) return jsonError("Request too large", 413);
  const body = await req.json().catch(() => null);
  const r = await handler(db(), body, clientIp(req.headers));
  return Response.json(r.body, { status: r.status, headers: { ...noStore, ...(r.status === 429 ? { "retry-after": "3600" } : {}), ...r.headers } });
}
