import { defaultDeps } from "@/lib/admin/deps";
import { revenueHandler } from "@/lib/admin/handlers";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => revenueHandler(req, defaultDeps());
