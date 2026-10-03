import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/server";
import { buildContext } from "@/lib/tools/context";

export const dynamic = "force-dynamic";

const Ref = z.object({ tool: z.string().regex(/^[a-z]{2,20}$/), id: z.string().min(1).max(64) });

async function ctxOr401() {
  const session = await getSession();
  if (!session) return { error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) } as const;
  const ctx = await buildContext(session);
  if (!ctx) return { error: NextResponse.json({ error: "Set up your business first" }, { status: 409 }) } as const;
  return { ctx } as const;
}

export async function GET(req: Request) {
  const r = await ctxOr401();
  if ("error" in r) return r.error;
  const u = new URL(req.url);
  const ref = Ref.safeParse({ tool: u.searchParams.get("tool"), id: u.searchParams.get("id") });
  if (!ref.success) return NextResponse.json({ error: "Invalid reference" }, { status: 400 });
  return NextResponse.json({ links: await r.ctx.links.list(ref.data) });
}

export async function POST(req: Request) {
  const r = await ctxOr401();
  if ("error" in r) return r.error;
  const body = z.object({ from: Ref, to: Ref, kind: z.string().max(40).optional() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  try {
    await r.ctx.links.add(body.data.from, body.data.to, body.data.kind);
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const r = await ctxOr401();
  if ("error" in r) return r.error;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  try {
    await r.ctx.links.remove(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }
}
