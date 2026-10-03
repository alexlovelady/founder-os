import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { runToolMigrations } from "./migrate";
import { withPlatform } from "./context";
import type { AiClient, AiRequest, AiStatus, Facts, Role, ToolContext, ToolDef } from "./index";

const URL = process.env.TEST_DATABASE_URL ?? "postgresql://legalai:legalai-dev@localhost:5442/founderos_test";
const here = dirname(fileURLToPath(import.meta.url));

/** A scripted AI for tests: replies are consumed in order; `reply` is used once the list runs out. */
export class FakeAi implements AiClient {
  available = true;
  calls: AiRequest[] = [];
  constructor(private replies: string[] = [], private reply = "ok") {}
  async start(req: AiRequest) {
    this.calls.push(req);
    return { jobId: `fake-${this.calls.length}` };
  }
  async poll(jobId: string): Promise<AiStatus> {
    const i = Number(jobId.replace("fake-", "")) - 1;
    return { state: "done", text: this.replies[i] ?? this.reply };
  }
}

export interface TestEnv {
  sql: ReturnType<typeof postgres>;
  ctx: ToolContext;
  /** A second business in the same database, for tenant-isolation tests. */
  other: ToolContext;
  ai: FakeAi;
  cleanup(): Promise<void>;
}

/** Real Postgres, real migrations, two isolated test businesses. Requires the local founderos_test database (see docs/DEVELOPMENT.md). */
export async function makeTestEnv(tools: ToolDef[], opts: { role?: Role; facts?: Facts; ai?: FakeAi } = {}): Promise<TestEnv> {
  const sql = postgres(URL, { max: 3, onnotice: () => {} });
  const dir = join(here, "../../../shell/migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await sql.unsafe(readFileSync(join(dir, f), "utf8"));
  await runToolMigrations(sql, tools);
  const ai = opts.ai ?? new FakeAi();
  const make = async (name: string, role: Role): Promise<ToolContext> => {
    const [b] = await sql<{ id: string }[]>`INSERT INTO businesses (name, entity_type, state) VALUES (${name}, 'llc', 'North Carolina') RETURNING id`;
    const userId = `test-user-${b.id.slice(0, 8)}`;
    await sql`INSERT INTO business_members (business_id, user_id, role) VALUES (${b.id}, ${userId}, ${role})`;
    const base = {
      sql,
      businessId: b.id,
      userId,
      role,
      canWrite: role !== "viewer",
      business: { id: b.id, name, description: "", industry: "Home services", entityType: "llc", country: "United States", state: "North Carolina", city: "Charlotte", website: "", lifecycleStage: "operating", employeeCount: 2, operations: { usesContractors: true, hasWebsite: true, collectsPersonalData: true }, goals: [] },
      ai,
    };
    const full = withPlatform(base, tools);
    if (opts.facts) full.facts = async () => opts.facts!;
    return full;
  };
  const ctx = await make("Test Co A", opts.role ?? "owner");
  const other = await make("Test Co B", "owner");
  return {
    sql, ctx, other, ai,
    async cleanup() {
      await sql`DELETE FROM businesses WHERE id IN (${ctx.businessId}, ${other.businessId})`;
      await sql.end();
    },
  };
}

/** Call a tool's api handler like the shell does. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read arbitrary JSON
export async function call(tool: ToolDef, ctx: ToolContext, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const req = new Request(`http://test/api/tools/${tool.id}/${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await tool.api!(ctx, req, path.split("?")[0].split("/").filter(Boolean));
  return { status: res.status, data: await res.json().catch(() => null) };
}
