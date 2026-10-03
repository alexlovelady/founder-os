import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/server";
import { BusinessInput, updateBusiness } from "@/lib/business";
import { syncLegal } from "@/lib/legal";

export const dynamic = "force-dynamic";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = BusinessInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  const updated = await updateBusiness(session.user.id, id, parsed.data);
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ws = (updated.modules.legal as { workspaceId?: string } | undefined)?.workspaceId;
  const synced = ws ? await syncLegal(session, ws, updated) : false;
  return NextResponse.json({ ok: true, legalSynced: synced });
}
