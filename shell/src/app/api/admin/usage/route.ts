import { defaultDeps } from "@/lib/admin/deps";
import { usageHandler } from "@/lib/admin/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => usageHandler(req, defaultDeps());
