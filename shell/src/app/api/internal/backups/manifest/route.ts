import { db } from "@/lib/db";
import { manifestResponse } from "@/lib/ops/pull";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return manifestResponse(db(), req);
}
