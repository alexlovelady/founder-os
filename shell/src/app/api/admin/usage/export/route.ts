import { defaultDeps } from "@/lib/admin/deps";
import { usageExportHandler } from "@/lib/admin/handlers";

export const dynamic = "force-dynamic";

/** Admin-only CSV of the usage table (?view=metric|business|day&from=&to=&metric=). */
export const GET = (req: Request) => usageExportHandler(req, defaultDeps());
