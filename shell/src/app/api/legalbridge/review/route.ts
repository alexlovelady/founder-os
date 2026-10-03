import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/server";
import { currentBusiness } from "@/lib/business";
import { reviewInLegal } from "@/lib/legalbridge/bridge";
import { buildContext } from "@/lib/tools/context";
import { getTool } from "@/lib/tools/registry";

export const dynamic = "force-dynamic";

const Body = z.object({ documentId: z.string().max(64), perspective: z.string().max(20) });

/** Send a vault document to LegalAI and start a contract review. Body: { documentId, perspective }. */
export async function POST(req: Request) {
  // A JSON content type cannot be sent by a plain cross-site form post, which blocks the simplest forged requests.
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return NextResponse.json({ error: "Expected a JSON body" }, { status: 415 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const ctx = await buildContext(session);
  if (!ctx) return NextResponse.json({ error: "Set up your business first" }, { status: 409 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Expected { documentId, perspective }" }, { status: 400 });
  const tool = getTool("vault");
  if (!tool?.api || tool.status !== "live") return NextResponse.json({ error: "The document vault is not available" }, { status: 404 });
  // The workspace id comes from the signed-in user's own business record, never from the request.
  const business = await currentBusiness(session.user.id);
  const workspaceId = (business?.modules.legal as { workspaceId?: string } | undefined)?.workspaceId;
  const result = await reviewInLegal({ ctx, tool, documentId: parsed.data.documentId, perspective: parsed.data.perspective, workspaceId, session: { cookie: session.cookie, csrf: session.csrf } });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
