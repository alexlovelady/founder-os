import { realNet } from "@founderos/compliance/src/source-check";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/platform/audit";
import type { Deps } from "./_lib";

/** Real database, real audit log and the real (SSRF-guarded) network for the admin compliance routes. */
export const liveDeps = (): Deps => ({ sql: db(), audit: recordAudit, net: realNet });
