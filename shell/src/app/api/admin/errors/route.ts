import { db } from "@/lib/db";
import { listErrors } from "@/lib/ops/errors";
import { adminApi } from "@/lib/platform/http";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const a = await adminApi(req, { write: false });
  if ("response" in a) return a.response;
  const s = new URL(req.url).searchParams.get("status");
  return Response.json({ errors: await listErrors(db(), { status: s === "resolved" || s === "all" ? s : "open" }) });
}
