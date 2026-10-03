import { getSession } from "@/lib/auth/server";
import { liveDeps } from "./_deps";
import { opCreate, opList } from "./_lib";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return opList(await getSession(), req, liveDeps());
}

export async function POST(req: Request) {
  return opCreate(await getSession(), req, liveDeps());
}
