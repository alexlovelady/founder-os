import { withPlatform, type AiClient, type Sql, type ToolContext, type ToolDef } from "@founderos/sdk";
import { createNotification } from "./index";

/** There is no AI in background jobs: tools must degrade gracefully, exactly as when a business has no AI workspace. */
const noAi: AiClient = {
  available: false,
  async start() {
    throw new Error("AI is not available in background jobs");
  },
  async poll() {
    return { state: "failed", error: "AI is not available in background jobs" };
  },
};

interface BusinessRow {
  id: string; name: string; description: string; industry: string; entity_type: string; country: string; state: string; city: string;
  website: string; lifecycle_stage: string; employee_count: number | null; operations: Record<string, boolean>; goals: string[];
}

/**
 * The same ToolContext the app builds for a signed-in user (see lib/tools/context.ts), but for background jobs: role "owner", no AI, no LegalAI
 * summaries, and a notify() that writes straight to this business's inbox. Returns null if the business does not exist.
 * `tools` defaults to the real registry (loaded lazily so tests can pass scripted tools).
 */
export async function buildSystemContext(sql: Sql, businessId: string, tools?: ToolDef[]): Promise<ToolContext | null> {
  const [b] = await sql<BusinessRow[]>`SELECT id, name, description, industry, entity_type, country, state, city, website, lifecycle_stage, employee_count, operations, goals FROM businesses WHERE id = ${businessId}`;
  if (!b) return null;
  const list = tools ?? (await import("@/lib/tools/registry")).TOOLS;
  return withPlatform(
    {
      sql,
      businessId: b.id,
      userId: "system",
      role: "owner",
      canWrite: true,
      business: {
        id: b.id, name: b.name, description: b.description, industry: b.industry, entityType: b.entity_type, country: b.country, state: b.state,
        city: b.city, website: b.website, lifecycleStage: b.lifecycle_stage, employeeCount: b.employee_count, operations: b.operations, goals: b.goals,
      },
      ai: noAi,
    },
    list,
    { services: { notify: async (n) => { await createNotification(sql, b.id, n); } } },
  );
}
