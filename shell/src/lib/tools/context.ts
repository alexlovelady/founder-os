import { withPlatform, type Role, type ToolContext } from "@founderos/sdk";
import type { Session } from "../auth/server";
import { currentBusiness } from "../business";
import { db } from "../db";
import { legalSummary } from "../legal";
import { recordAudit } from "../platform/audit";
import { createNotification } from "../notify";
import { planFor, quotaFor } from "./plan";
import { makeAiClient } from "./ai";
import { TOOLS } from "./registry";

/** Build the tenant-scoped context a tool runs with. The business comes from the verified session membership, never from the request. */
export async function buildContext(session: Session): Promise<ToolContext | null> {
  const business = await currentBusiness(session.user.id);
  if (!business) return null;
  const role = business.role as Role;
  const sql = db();
  const plan = await planFor(sql, business.id);
  const workspaceId = (business.modules.legal as { workspaceId?: string } | undefined)?.workspaceId;

  return withPlatform(
    {
      sql,
      businessId: business.id,
      userId: session.user.id,
      role,
      canWrite: role !== "viewer",
      business: {
        id: business.id,
        name: business.name,
        description: business.description,
        industry: business.industry,
        entityType: business.entityType,
        country: business.country,
        state: business.state,
        city: business.city,
        website: business.website,
        lifecycleStage: business.lifecycleStage,
        employeeCount: business.employeeCount,
        operations: business.operations,
        goals: business.goals,
      },
      ai: makeAiClient(session, workspaceId),
    },
    TOOLS,
    {
      services: {
        audit: (action, meta, resource) => recordAudit(sql, { businessId: business.id, userId: session.user.id, action, meta, resource }),
        notify: async (n) => {
          await createNotification(sql, business.id, n);
        },
        plan,
        useQuota: quotaFor(sql, business.id, session.user.id),
      },
      // LegalAI is a separate service, so it contributes to the shared context here rather than as a tool.
      extraSummaries: async (): Promise<Record<string, string>> => {
        if (!workspaceId) return {};
        const s = await legalSummary(session, workspaceId);
        if (!s) return {};
        const open = s.open.map((i) => i.title).join("; ");
        return { legal: `Legal basics checklist: ${s.done} of ${s.total} done.${open ? ` Still open: ${open}.` : ""}` };
      },
    },
  );
}
