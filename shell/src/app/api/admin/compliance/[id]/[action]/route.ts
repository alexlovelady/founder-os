import { getSession } from "@/lib/auth/server";
import { liveDeps } from "../../_deps";
import { opAction } from "../../_lib";

export const dynamic = "force-dynamic";

/** POST /api/admin/compliance/<rule>/<publish|disable|restore|verify|check> */
export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await ctx.params;
  return opAction(await getSession(), req, liveDeps(), id, action);
}
