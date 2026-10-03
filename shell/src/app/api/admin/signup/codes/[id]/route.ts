import { db } from "@/lib/db";
import { recordAudit } from "@/lib/platform/audit";
import { adminApi, jsonError } from "@/lib/platform/http";
import { revokeCode } from "@/lib/signup/codes";

export const dynamic = "force-dynamic";

/** Revokes an invite code (it stays in the table for the record). */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const a = await adminApi(req, { write: true });
  if ("response" in a) return a.response;
  const { id } = await ctx.params;
  const sql = db();
  const s = await revokeCode(sql, id);
  if (!s) return jsonError("Not found", 404);
  await recordAudit(sql, { businessId: null, userId: a.session.user.id, action: "admin.signup.code_revoked", resource: { tool: "platform", id: s.id }, meta: { label: s.label } });
  return Response.json({ ok: true, summary: s });
}
