import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/server";
import { buildContext } from "@/lib/tools/context";
import { getTool } from "@/lib/tools/registry";

export const dynamic = "force-dynamic";

async function handle(req: Request, params: Promise<{ tool: string; path: string[] }>) {
  const { tool: id, path } = await params;
  const tool = getTool(id);
  if (!tool?.api || tool.status !== "live") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const ctx = await buildContext(session);
  if (!ctx) return NextResponse.json({ error: "Set up your business first" }, { status: 409 });
  return tool.api(ctx, req, path);
}

type P = { params: Promise<{ tool: string; path: string[] }> };
export const GET = (req: Request, { params }: P) => handle(req, params);
export const POST = (req: Request, { params }: P) => handle(req, params);
export const PUT = (req: Request, { params }: P) => handle(req, params);
export const PATCH = (req: Request, { params }: P) => handle(req, params);
export const DELETE = (req: Request, { params }: P) => handle(req, params);
