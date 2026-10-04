import { db } from "@/lib/db";
import { setResolved } from "@/lib/ops/errors";
import { recordAudit } from "@/lib/platform/audit";
import { adminApi, jsonError } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

/** Mark an error group resolved (or reopen it): body { resolved: boolean }. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await adminApi(req, { write: true });
  if ("response" in a) return a.response;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { resolved?: unknown } | null;
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1 || typeof body?.resolved !== "boolean") return jsonError("Invalid input", 400);
  const sql = db();
  if (!(await setResolved(sql, n, body.resolved))) return jsonError("Not found", 404);
  await recordAudit(sql, { businessId: null, userId: a.session.user.id, action: body.resolved ? "admin.error.resolve" : "admin.error.reopen", resource: { tool: "platform", id: String(n) } });
  return Response.json({ ok: true });
}
