import { defaultDeps } from "@/lib/admin/deps";
import { listSuspensionsHandler } from "@/lib/admin/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => listSuspensionsHandler(req, defaultDeps());
