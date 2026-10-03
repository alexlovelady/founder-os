import { getSession } from "@/lib/auth/server";
import { liveDeps } from "../_deps";
import { opGet, opUpdate } from "../_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return opGet(await getSession(), req, liveDeps(), id);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return opUpdate(await getSession(), req, liveDeps(), id);
}
