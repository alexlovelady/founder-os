import { z } from "zod";
import { db } from "@/lib/db";
import { jsonError } from "@/lib/platform/http";
import { memberApi } from "@/lib/platform/member";
import { deleteBusiness } from "@/lib/platform/privacy";

export const dynamic = "force-dynamic";

const Body = z.object({ confirmName: z.string().min(1).max(200) });

/**
 * Permanently delete the caller's business and all its tool data (owner only; the business name must be typed).
 * Does not delete the sign-in account or LegalAI workspace data (those live in LegalAI).
 */
export async function POST(req: Request) {
  const m = await memberApi(req, { write: true, roles: ["owner"] });
  if ("response" in m) return m.response;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Type the business name to confirm", 400);
  const result = await deleteBusiness(db(), { businessId: m.business.id, userId: m.session.user.id, confirmName: parsed.data.confirmName });
  if (!result.ok) return jsonError(result.error, result.status);
  return Response.json({
    deleted: true,
    note: "Your FounderOS business data is deleted. Your sign-in account and any LegalAI workspace data are managed in LegalAI and were not removed.",
  });
}
