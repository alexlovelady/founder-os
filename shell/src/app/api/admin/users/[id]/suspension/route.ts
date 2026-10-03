import { defaultDeps } from "@/lib/admin/deps";
import { liftHandler, suspendHandler } from "@/lib/admin/handlers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Suspend the user (body: { reason }). */
export async function POST(req: Request, ctx: Ctx) {
  return suspendHandler(req, defaultDeps(), decodeURIComponent((await ctx.params).id));
}

/** Lift the suspension (body: { reason }). */
export async function DELETE(req: Request, ctx: Ctx) {
  return liftHandler(req, defaultDeps(), decodeURIComponent((await ctx.params).id));
}
