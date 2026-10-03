import { getSession } from "@/lib/auth/server";
import { opPreview } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return opPreview(await getSession(), req);
}
