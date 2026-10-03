import { db } from "@/lib/db";
import { recordAudit } from "@/lib/platform/audit";
import { memberApi } from "@/lib/platform/member";
import { exportBusinessData } from "@/lib/platform/privacy";
import { TOOLS } from "@/lib/tools/registry";

export const dynamic = "force-dynamic";

/** Download everything the product holds for the caller's business as JSON (owner or admin). */
export async function GET(req: Request) {
  const m = await memberApi(req, { write: false, roles: ["owner", "admin"] });
  if ("response" in m) return m.response;
  const sql = db();
  const data = await exportBusinessData(sql, m.business.id, TOOLS.map((t) => t.id));
  await recordAudit(sql, { businessId: m.business.id, userId: m.session.user.id, action: "privacy.export" });
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="founderos-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}
