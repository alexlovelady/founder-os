import { db } from "@/lib/db";
import { jsonError } from "@/lib/platform/http";
import { memberApi } from "@/lib/platform/member";
import { getPrivacySettings, PrivacySettingsInput, setPrivacySettings } from "@/lib/platform/privacy";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const m = await memberApi(req, { write: false });
  if ("response" in m) return m.response;
  return Response.json(await getPrivacySettings(db(), m.business.id));
}

export async function PUT(req: Request) {
  const m = await memberApi(req, { write: true, roles: ["owner", "admin"] });
  if ("response" in m) return m.response;
  const parsed = PrivacySettingsInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  return Response.json(await setPrivacySettings(db(), m.business.id, m.session.user.id, parsed.data));
}
