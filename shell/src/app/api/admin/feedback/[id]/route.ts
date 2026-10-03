import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/platform/audit";
import { setFeedbackStatus } from "@/lib/platform/feedback";
import { adminApi, jsonError } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

const Body = z.object({ status: z.enum(["new", "handled"]) });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await adminApi(req, { write: true });
  if ("response" in a) return a.response;
  const { id } = await ctx.params;
  const n = Number(id);
  if (!Number.isSafeInteger(n) || n < 1) return jsonError("Not found", 404);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid status", 400);
  const sql = db();
  if (!(await setFeedbackStatus(sql, n, parsed.data.status))) return jsonError("Not found", 404);
  await recordAudit(sql, { businessId: null, userId: a.session.user.id, action: "admin.feedback.status", resource: { tool: "platform", id: String(n) }, meta: { status: parsed.data.status } });
  return Response.json({ ok: true });
}
