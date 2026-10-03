import { z } from "zod";
import { db } from "./db";

export { ENTITY_TYPES, STAGES, OPERATION_QUESTIONS, GOALS } from "./business-options";
import { ENTITY_TYPES, STAGES, type Business } from "./business-options";
export type { Business };

const entityIds = ENTITY_TYPES.map((e) => e.id) as [string, ...string[]];
const stageIds = STAGES.map((s) => s.id) as [string, ...string[]];

export const BusinessInput = z.object({
  name: z.string().trim().min(1, "Enter your business name").max(150),
  description: z.string().trim().max(1000).default(""),
  industry: z.string().trim().max(150).default(""),
  entityType: z.enum(entityIds).default("not_sure"),
  country: z.string().trim().min(1).max(100).default("United States"),
  state: z.string().trim().max(100).default(""),
  city: z.string().trim().max(100).default(""),
  website: z.string().trim().max(300).default(""),
  lifecycleStage: z.enum(stageIds).default("idea"),
  employeeCount: z.number().int().min(0).max(100000).nullable().default(null),
  operations: z.record(z.string(), z.boolean()).default({}),
  goals: z.array(z.string().max(100)).max(20).default([]),
});
export type BusinessInput = z.infer<typeof BusinessInput>;

type Row = {
  id: string; name: string; description: string; industry: string; entity_type: string; country: string; state: string; city: string;
  website: string; lifecycle_stage: string; employee_count: number | null; operations: Record<string, boolean>; goals: string[];
  modules: Record<string, unknown>; created_at: Date; role: string;
};

const toBusiness = (r: Row): Business => ({
  id: r.id, name: r.name, description: r.description, industry: r.industry, entityType: r.entity_type, country: r.country, state: r.state,
  city: r.city, website: r.website, lifecycleStage: r.lifecycle_stage, employeeCount: r.employee_count, operations: r.operations,
  goals: r.goals, modules: r.modules, role: r.role, createdAt: r.created_at.toISOString(),
});

/** Every read and write below is scoped by membership: a user only ever sees businesses they belong to. */
export async function listBusinesses(userId: string): Promise<Business[]> {
  const rows = await db()<Row[]>`
    SELECT b.*, m.role FROM businesses b JOIN business_members m ON m.business_id = b.id
    WHERE m.user_id = ${userId} ORDER BY b.created_at`;
  return rows.map(toBusiness);
}

export async function currentBusiness(userId: string): Promise<Business | null> {
  const all = await listBusinesses(userId);
  try {
    // The user's chosen business (set by the business switcher). Membership is already guaranteed by listBusinesses.
    const { cookies } = await import("next/headers");
    const want = (await cookies()).get("fos_business")?.value;
    const picked = want ? all.find((b) => b.id === want) : undefined;
    if (picked) return picked;
  } catch {
    /* no request scope (scheduler, tests): fall back to the first business */
  }
  return all[0] ?? null;
}

export async function createBusiness(userId: string, input: BusinessInput): Promise<Business> {
  const sql = db();
  return sql.begin(async (tx) => {
    const [b] = await tx<{ id: string }[]>`
      INSERT INTO businesses (name, description, industry, entity_type, country, state, city, website, lifecycle_stage, employee_count, operations, goals)
      VALUES (${input.name}, ${input.description}, ${input.industry}, ${input.entityType}, ${input.country}, ${input.state}, ${input.city},
              ${input.website}, ${input.lifecycleStage}, ${input.employeeCount}, ${tx.json(input.operations)}, ${tx.json(input.goals)})
      RETURNING id`;
    await tx`INSERT INTO business_members (business_id, user_id, role) VALUES (${b.id}, ${userId}, 'owner')`;
    const [row] = await tx<Row[]>`SELECT b.*, m.role FROM businesses b JOIN business_members m ON m.business_id = b.id WHERE b.id = ${b.id} AND m.user_id = ${userId}`;
    return toBusiness(row);
  });
}

export async function updateBusiness(userId: string, businessId: string, input: BusinessInput): Promise<Business | null> {
  const sql = db();
  const [ok] = await sql`SELECT 1 FROM business_members WHERE business_id = ${businessId} AND user_id = ${userId} AND role IN ('owner', 'admin')`;
  if (!ok) return null;
  await sql`
    UPDATE businesses SET name = ${input.name}, description = ${input.description}, industry = ${input.industry}, entity_type = ${input.entityType},
      country = ${input.country}, state = ${input.state}, city = ${input.city}, website = ${input.website}, lifecycle_stage = ${input.lifecycleStage},
      employee_count = ${input.employeeCount}, operations = ${sql.json(input.operations)}, goals = ${sql.json(input.goals)}, updated_at = now()
    WHERE id = ${businessId}`;
  return (await listBusinesses(userId)).find((b) => b.id === businessId) ?? null;
}

export async function setModuleLink(businessId: string, module: string, link: Record<string, unknown>) {
  const sql = db();
  await sql`UPDATE businesses SET modules = modules || ${sql.json({ [module]: link } as never)}, updated_at = now() WHERE id = ${businessId}`;
}
