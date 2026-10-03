import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/platform/audit";
import { adminApi, jsonError } from "@/lib/platform/http";
import { createCode, listCodes, MAX_EXPIRY_DAYS, MAX_USES_LIMIT } from "@/lib/signup/codes";

export const dynamic = "force-dynamic";

const Body = z.object({
  label: z.string().trim().max(100).optional(),
  maxUses: z.number().int().min(1).max(MAX_USES_LIMIT).default(1),
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).nullable().default(null),
});

export async function GET(req: Request) {
  const a = await adminApi(req, { write: false });
  if ("response" in a) return a.response;
  return Response.json({ codes: await listCodes(db()) });
}

/** Creates an invite code. The raw code is in this response ONCE; only its hash is stored and it is never audited. */
export async function POST(req: Request) {
  const a = await adminApi(req, { write: true });
  if ("response" in a) return a.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const sql = db();
  const r = await createCode(sql, { actorId: a.session.user.id, ...parsed.data });
  if (!r.ok) return jsonError(r.message, 400);
  await recordAudit(sql, {
    businessId: null, userId: a.session.user.id, action: "admin.signup.code_created", resource: { tool: "platform", id: r.summary.id },
    meta: { label: r.summary.label, maxUses: r.summary.maxUses, expiresAt: r.summary.expiresAt },
  });
  return Response.json({ code: r.code, summary: r.summary }, { status: 201, headers: { "cache-control": "no-store" } });
}
