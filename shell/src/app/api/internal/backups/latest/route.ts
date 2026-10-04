import { db } from "@/lib/db";
import { latestResponse } from "@/lib/ops/pull";

export const dynamic = "force-dynamic";

/** Off-site pull: the newest verified dump, token-gated (X-Internal-Token = BACKUP_PULL_TOKEN). 404 when the token is not configured. */
export async function GET(req: Request) {
  return latestResponse(db(), req);
}
