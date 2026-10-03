import { defaultDeps } from "@/lib/admin/deps";
import { clearOverrideHandler, setOverrideHandler } from "@/lib/admin/handlers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Set or replace the plan override (body: { plan, limits?, reason }). */
export async function PUT(req: Request, ctx: Ctx) {
  return setOverrideHandler(req, defaultDeps(), (await ctx.params).id);
}

export async function DELETE(req: Request, ctx: Ctx) {
  return clearOverrideHandler(req, defaultDeps(), (await ctx.params).id);
}
