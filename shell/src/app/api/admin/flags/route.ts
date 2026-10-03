import { db } from "@/lib/db";
import { recordAudit } from "@/lib/platform/audit";
import { FlagInput, listFlags, OverrideInput, setOverride, upsertFlag } from "@/lib/platform/flags";
import { adminApi, jsonError } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await adminApi(req, { write: false });
  if ("response" in a) return a.response;
  return Response.json({ flags: await listFlags(db()) });
}

/** Create or update a flag. */
export async function PUT(req: Request) {
  const a = await adminApi(req, { write: true });
  if ("response" in a) return a.response;
  const parsed = FlagInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const sql = db();
  await upsertFlag(sql, parsed.data, a.session.user.id);
  await recordAudit(sql, {
    businessId: null, userId: a.session.user.id, action: "admin.flag.update",
    resource: { tool: "platform", id: parsed.data.key }, meta: { enabled: parsed.data.enabled, rolloutPct: parsed.data.rolloutPct },
  });
  return Response.json({ ok: true });
}

/** Set (enabled true/false) or remove (enabled null) a per-business override. */
export async function POST(req: Request) {
  const a = await adminApi(req, { write: true });
  if ("response" in a) return a.response;
  const parsed = OverrideInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const sql = db();
  const ok = await setOverride(sql, parsed.data.businessId, parsed.data.key, parsed.data.enabled);
  if (!ok) return jsonError("Unknown flag or business", 404);
  await recordAudit(sql, {
    businessId: parsed.data.businessId, userId: a.session.user.id, action: "admin.flag.override",
    resource: { tool: "platform", id: parsed.data.key }, meta: { enabled: parsed.data.enabled },
  });
  return Response.json({ ok: true });
}
