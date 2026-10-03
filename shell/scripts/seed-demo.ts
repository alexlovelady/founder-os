/**
 * Demo data (build spec section 67): the business "BrightSide Cleaning LLC" with documents, compliance items, tasks, CRM, SOPs,
 * saved finance calculations and a competitor, for one LegalAI user.
 *
 *   npx tsx shell/scripts/seed-demo.ts <ownerUserId> [--yes-i-mean-production]
 *
 * Reads DATABASE_URL (default: the local dev database). Refuses to touch a database whose host is not localhost / 127.0.0.1
 * unless --yes-i-mean-production is passed. Everything is created through the tools' own API handlers with a ToolContext built by
 * withPlatform, so validation, versioning and limits are the same as in the product. Re-running updates in place: nothing is duplicated.
 * No network access: the competitor is only recorded, never fetched, and nothing calls the AI.
 */
import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { withPlatform, type AiClient, type ToolContext, type ToolDef } from "@founderos/sdk";
import { runToolMigrations } from "@founderos/sdk/migrate";
import { TOOLS } from "../src/lib/tools/registry";

export const DEMO_NAME = "BrightSide Cleaning LLC";
const LOCAL_URL = "postgresql://legalai:legalai-dev@localhost:5442/founderos";

/** Throws unless the URL points at this machine or `allowProduction` is set. Judged on the parsed host, not on a substring. */
export function assertSafeDatabase(url: string, allowProduction = false): void {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");
  if (!local && !allowProduction) {
    throw new Error(`Refusing to seed demo data into "${host}": it is not localhost or 127.0.0.1. Pass --yes-i-mean-production if you really mean it.`);
  }
}

type Sql = ReturnType<typeof postgres>;

/** The demo has no AI: tools that need it degrade as they do when the AI service is unreachable. */
const noAi: AiClient = {
  available: false,
  async start() {
    throw new Error("AI is not available in the demo seed");
  },
  async poll() {
    return { state: "failed", error: "AI is not available in the demo seed" } as never;
  },
};

const PROFILE = {
  name: DEMO_NAME,
  description: "Residential cleaning for homes in the Charlotte area: weekly and bi-weekly recurring service, deep cleans and move-out cleans.",
  industry: "Residential cleaning",
  entityType: "llc",
  country: "United States",
  state: "North Carolina",
  city: "Charlotte",
  website: "https://brightsidecleaning.example",
  lifecycleStage: "operating",
  employeeCount: 2,
  operations: { hasEmployees: true, usesContractors: true, hasCustomers: true, hasWebsite: true, collectsPersonalData: true, takesOnlinePayments: true, recurringBilling: true },
  goals: ["Stay compliant", "Organize documents", "Find customers", "Prepare to hire"],
};

/** Find or create the demo business for this user and bring its profile up to date. */
async function ensureBusiness(sql: Sql, owner: string): Promise<string> {
  const p = PROFILE;
  const [found] = await sql<{ id: string }[]>`
    SELECT b.id FROM businesses b JOIN business_members m ON m.business_id = b.id
    WHERE m.user_id = ${owner} AND b.name = ${DEMO_NAME} ORDER BY b.created_at LIMIT 1`;
  if (found) {
    await sql`
      UPDATE businesses SET description = ${p.description}, industry = ${p.industry}, entity_type = ${p.entityType}, country = ${p.country}, state = ${p.state}, city = ${p.city},
        website = ${p.website}, lifecycle_stage = ${p.lifecycleStage}, employee_count = ${p.employeeCount}, operations = ${sql.json(p.operations)}, goals = ${sql.json(p.goals)}, updated_at = now()
      WHERE id = ${found.id}`;
    await sql`UPDATE business_members SET role = 'owner' WHERE business_id = ${found.id} AND user_id = ${owner}`;
    return found.id;
  }
  return sql.begin(async (tx) => {
    const [b] = await tx<{ id: string }[]>`
      INSERT INTO businesses (name, legal_name, description, industry, entity_type, country, state, city, website, lifecycle_stage, employee_count, operations, goals)
      VALUES (${p.name}, ${p.name}, ${p.description}, ${p.industry}, ${p.entityType}, ${p.country}, ${p.state}, ${p.city}, ${p.website}, ${p.lifecycleStage}, ${p.employeeCount}, ${tx.json(p.operations)}, ${tx.json(p.goals)})
      RETURNING id`;
    await tx`INSERT INTO business_members (business_id, user_id, role) VALUES (${b.id}, ${owner}, 'owner')`;
    return b.id;
  });
}

function makeContext(sql: Sql, businessId: string, owner: string, tools: ToolDef[]): ToolContext {
  const p = PROFILE;
  return withPlatform(
    {
      sql,
      businessId,
      userId: owner,
      role: "owner",
      canWrite: true,
      business: { id: businessId, name: p.name, description: p.description, industry: p.industry, entityType: p.entityType, country: p.country, state: p.state, city: p.city, website: p.website, lifecycleStage: p.lifecycleStage, employeeCount: p.employeeCount, operations: p.operations, goals: p.goals },
      ai: noAi,
    },
    tools,
  );
}

const iso = (daysFromNow: number): string => {
  const d = new Date(Date.now() + daysFromNow * 86_400_000);
  return d.toISOString().slice(0, 10);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the handlers return arbitrary JSON
type Json = any;

/** Call a tool's api handler the way the shell's route does. */
async function call(tool: ToolDef, ctx: ToolContext, method: string, path: string, body?: unknown): Promise<{ status: number; data: Json }> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  const req = new Request(`http://seed.local/api/tools/${tool.id}/${path}`, init);
  const res = await tool.api!(ctx, req, path.split("?")[0].split("/").filter(Boolean));
  return { status: res.status, data: await res.json().catch(() => null) };
}

function must(r: { status: number; data: Json }, what: string): Json {
  if (r.status >= 200 && r.status < 300) return r.data;
  throw new Error(`${what} failed (${r.status}): ${JSON.stringify(r.data)}`);
}

export interface SeedReport {
  businessId: string;
  created: Record<string, number>;
  existing: Record<string, number>;
}

const DOCUMENTS: { name: string; file: string; category: string; docType: string; tags: string[]; text: string }[] = [
  {
    name: "Customer Service Agreement",
    file: "brightside-customer-service-agreement.txt",
    category: "Contracts",
    docType: "Customer service agreement",
    tags: ["demo", "customers"],
    text: `CUSTOMER SERVICE AGREEMENT (DEMO)

This sample agreement is between ${DEMO_NAME} ("BrightSide") and the customer named on the booking.

1. Services. BrightSide provides residential cleaning on the schedule agreed at booking (weekly, every two weeks, or one time).
2. Fees. The customer pays the quoted rate after each visit. Recurring customers are billed monthly in arrears.
3. Cancellation. The customer may cancel or reschedule up to 24 hours before a visit without charge.
4. Access and safety. The customer provides safe access and tells BrightSide about pets and alarm systems.
5. Damage. Report any damage within 48 hours so it can be reviewed.
6. Governing law. North Carolina.

This is sample text generated for demonstration. It is not legal advice.
`,
  },
  {
    name: "Independent Contractor Agreement",
    file: "brightside-contractor-agreement.txt",
    category: "Contractors",
    docType: "Contractor agreement",
    tags: ["demo", "contractors"],
    text: `INDEPENDENT CONTRACTOR AGREEMENT (DEMO)

This sample agreement is between ${DEMO_NAME} and the contractor named below.

1. Relationship. The contractor is an independent contractor, not an employee, and controls how the work is done.
2. Services. Deep-clean and move-out jobs assigned and accepted job by job.
3. Payment. A flat fee per job, paid within 7 days of completion. The contractor is responsible for their own taxes.
4. Supplies and insurance. The contractor brings their own equipment and carries general liability insurance.
5. Confidentiality. The contractor keeps customer addresses and access codes private.
6. Governing law. North Carolina.

This is sample text generated for demonstration. It is not legal advice.
`,
  },
  {
    name: "Privacy Policy",
    file: "brightside-privacy-policy.txt",
    category: "Policies",
    docType: "Privacy policy",
    tags: ["demo", "website"],
    text: `PRIVACY POLICY (DEMO)

${DEMO_NAME} collects the name, address, phone, email and access instructions that customers give us when booking.

What we do with it: schedule and perform visits, send reminders and invoices, and answer questions.
Who sees it: our employees and contractors who clean your home. We do not sell personal information.
Payments: handled by our payment processor; we do not store card numbers.
How long we keep it: while you are a customer and for seven years afterwards for tax records.
Your choices: ask us to correct or delete your information by emailing hello@brightsidecleaning.example.

This is sample text generated for demonstration. It is not legal advice.
`,
  },
];

const TASKS = [
  { title: "Renew Charlotte business privilege license", priority: "high", due: 14, description: "Demo task from the compliance checklist." },
  { title: "Send customer service agreement to the three newest customers", priority: "high", due: 3, description: "" },
  { title: "Collect certificate of insurance from contractor", priority: "medium", due: 7, description: "Needed before the next move-out job." },
  { title: "Run payroll for the two employees", priority: "high", due: 5, description: "", recurrence: "monthly" },
  { title: "Update the website price list for spring deep cleans", priority: "low", due: 30, description: "" },
  { title: "Follow up with recurring customers about holiday schedule", priority: "medium", due: 10, description: "" },
] as const;

const CONTACTS = [
  { name: "Maria Gonzalez", company: "", email: "maria.gonzalez@example.com", phone: "704-555-0111", type: "customer", tags: ["recurring", "weekly"] },
  { name: "James Whitfield", company: "", email: "james.whitfield@example.com", phone: "704-555-0112", type: "customer", tags: ["recurring", "bi-weekly"] },
  { name: "Priya Shah", company: "Shah Dental", email: "priya@shahdental.example.com", phone: "704-555-0113", type: "customer", tags: ["commercial"] },
  { name: "Tom Becker", company: "", email: "tom.becker@example.com", phone: "704-555-0114", type: "customer", tags: ["one-time"] },
  { name: "Alicia Brooks", company: "Brooks Realty", email: "alicia@brooksrealty.example.com", phone: "704-555-0115", type: "lead", tags: ["move-out", "referral"] },
  { name: "Daniel Okafor", company: "", email: "daniel.okafor@example.com", phone: "704-555-0116", type: "lead", tags: ["website"] },
  { name: "CleanSupply Co", company: "CleanSupply Co", email: "orders@cleansupply.example.com", phone: "704-555-0117", type: "vendor", tags: ["supplies"] },
  { name: "Charlotte Property Managers", company: "CPM Group", email: "partners@cpmgroup.example.com", phone: "704-555-0118", type: "partner", tags: ["referral"] },
] as const;

const OPPORTUNITIES = [
  { title: "Weekly cleaning: Shah Dental office", contact: "priya@shahdental.example.com", valueCents: 480_000, stage: "proposal_sent", close: 12 },
  { title: "Move-out cleans for Brooks Realty listings", contact: "alicia@brooksrealty.example.com", valueCents: 360_000, stage: "negotiation", close: 20 },
  { title: "Bi-weekly cleaning: Okafor household", contact: "daniel.okafor@example.com", valueCents: 156_000, stage: "qualified", close: 25 },
] as const;

const SOPS = [
  {
    title: "Standard Home Cleaning Checklist",
    kind: "checklist",
    body: `# Standard Home Cleaning Checklist

## Before you start
- Confirm access instructions and any pets or alarm codes in the booking notes.
- Take a quick photo of any existing damage.

## Every room
1. Dust high to low, then wipe surfaces.
2. Vacuum and mop floors last, working toward the exit.

## Kitchen
- Wipe counters, stovetop and the outside of appliances; clean the sink.

## Bathrooms
- Disinfect toilet, tub and sink; polish mirrors.

## Before you leave
- Walk the house with the checklist, lock up, and send the customer the completion message.
`,
  },
  {
    title: "Customer Complaint Handling",
    kind: "sop",
    body: `# Customer Complaint Handling

**Goal:** resolve a complaint within one business day and keep the customer.

1. Thank the customer and apologize for the experience. Do not argue.
2. Ask for photos and the date of the visit; log them in the CRM note for the contact.
3. Offer a free re-clean within 48 hours for anything missed.
4. If damage is reported, collect details and tell the owner the same day.
5. Follow up two days after the re-clean to confirm the customer is happy.
`,
  },
] as const;

const CALCULATIONS = [
  { kind: "runway", name: "Runway with current cash", inputs: { cash: 18_000, monthlyRecurringRevenue: 9_500, otherMonthlyRevenue: 2_200, monthlyExpenses: 10_800 } },
  { kind: "pricing", name: "Price for a standard 3-bedroom clean", inputs: { labor: 70, materials: 8, overhead: 12, desiredMarginPct: 35 } },
  { kind: "break_even", name: "Monthly break-even visits", inputs: { fixedExpenses: 4_200, variableCostPerSale: 38, pricePerSale: 135 } },
  { kind: "hire_compare", name: "Cleaner: employee or contractor", inputs: { employeeAnnualPay: 36_000, employerPayrollTaxPct: 9, annualBenefits: 1_800, otherAnnualEmployeeCosts: 900, contractorHourlyRate: 24, contractorHoursPerYear: 1_500 } },
  { kind: "tax_reserve", name: "Quarterly tax set-aside", inputs: { periodIncome: 31_000, reservePct: 25 } },
] as const;

const COMPETITOR = { name: "SparkleMaid Charlotte", url: "https://sparklemaid-charlotte.example.com", notes: "Demo competitor. Added by hand; nothing was fetched.", source: "manual" };

/** Create or update the demo business and its data. Safe to run again. */
export async function seedDemo(sql: Sql, ownerUserId: string, tools: ToolDef[] = TOOLS): Promise<SeedReport> {
  if (!ownerUserId.trim()) throw new Error("An owner user id is required");
  const businessId = await ensureBusiness(sql, ownerUserId);
  const ctx = makeContext(sql, businessId, ownerUserId, tools);
  const tool = (id: string): ToolDef => {
    const t = tools.find((x) => x.id === id);
    if (!t?.api) throw new Error(`Tool "${id}" is not available`);
    return t;
  };
  const created: Record<string, number> = {};
  const existing: Record<string, number> = {};
  const count = (map: Record<string, number>, k: string) => (map[k] = (map[k] ?? 0) + 1);

  // vault documents (through the real upload handler, so type checks, hashing and text extraction run)
  const vault = tool("vault");
  const haveDocs = new Set<string>((must(await call(vault, ctx, "GET", "documents?status=all"), "list documents").documents as Json[]).map((d) => d.name));
  for (const d of DOCUMENTS) {
    if (haveDocs.has(d.name)) { count(existing, "documents"); continue; }
    const form = new FormData();
    form.set("file", new File([d.text], d.file, { type: "text/plain" }));
    form.set("name", d.name);
    form.set("category", d.category);
    form.set("docType", d.docType);
    form.set("tags", JSON.stringify(d.tags));
    must(await call(vault, ctx, "POST", "documents", form), `upload ${d.name}`);
    count(created, "documents");
  }

  // compliance: the tool's own sync from the business profile (idempotent by design)
  const compliance = tool("compliance");
  const sync = must(await call(compliance, ctx, "POST", "sync"), "compliance sync");
  const items = (sync.items as Json[] | undefined)?.length ?? 0;
  existing.complianceItems = items;

  // tasks
  const tasks = tool("tasks");
  const haveTasks = new Set<string>((must(await call(tasks, ctx, "GET", "items?limit=500"), "list tasks").tasks as Json[]).map((t) => t.title));
  for (const t of TASKS) {
    if (haveTasks.has(t.title)) { count(existing, "tasks"); continue; }
    const body: Record<string, unknown> = { title: t.title, priority: t.priority, dueDate: iso(t.due) };
    if (t.description) body.description = t.description;
    if ("recurrence" in t) body.recurrence = t.recurrence;
    must(await call(tasks, ctx, "POST", "items", body), `task ${t.title}`);
    count(created, "tasks");
  }

  // CRM contacts, then opportunities
  const crm = tool("crm");
  const contactIds = new Map<string, string>();
  const listed = must(await call(crm, ctx, "GET", "contacts"), "list contacts").contacts as Json[];
  for (const c of listed) contactIds.set(String(c.email).toLowerCase(), c.id);
  for (const c of CONTACTS) {
    if (contactIds.has(c.email)) { count(existing, "contacts"); continue; }
    const data = must(await call(crm, ctx, "POST", "contacts", { name: c.name, company: c.company, email: c.email, phone: c.phone, type: c.type, tags: c.tags, source: "demo seed" }), `contact ${c.name}`);
    contactIds.set(c.email, data.contact.id);
    count(created, "contacts");
  }
  const haveOpps = new Set<string>((must(await call(crm, ctx, "GET", "opportunities"), "list opportunities").opportunities as Json[]).map((o) => o.title));
  for (const o of OPPORTUNITIES) {
    if (haveOpps.has(o.title)) { count(existing, "opportunities"); continue; }
    must(await call(crm, ctx, "POST", "opportunities", { contactId: contactIds.get(o.contact), title: o.title, valueCents: o.valueCents, stage: o.stage, expectedClose: iso(o.close) }), `opportunity ${o.title}`);
    count(created, "opportunities");
  }

  // SOP documents
  const sops = tool("sops");
  const haveSops = new Set<string>((must(await call(sops, ctx, "GET", "documents"), "list sops").documents as Json[]).map((d) => d.title));
  for (const s of SOPS) {
    if (haveSops.has(s.title)) { count(existing, "sops"); continue; }
    must(await call(sops, ctx, "POST", "documents", { title: s.title, kind: s.kind, body: s.body, status: "active", review_frequency: "yearly" }), `sop ${s.title}`);
    count(created, "sops");
  }

  // saved finance calculations
  const finance = tool("finance");
  const haveCalcs = new Set<string>((must(await call(finance, ctx, "GET", "calculations"), "list calculations").calculations as Json[]).map((c) => c.name));
  for (const c of CALCULATIONS) {
    if (haveCalcs.has(c.name)) { count(existing, "calculations"); continue; }
    must(await call(finance, ctx, "POST", "calculations", { kind: c.kind, name: c.name, inputs: c.inputs }), `calculation ${c.name}`);
    count(created, "calculations");
  }

  // one competitor, recorded only (no fetch, no network)
  const competitors = tool("competitors");
  const r = await call(competitors, ctx, "POST", "competitors", COMPETITOR);
  if (r.status === 409) count(existing, "competitors");
  else {
    must(r, "competitor");
    count(created, "competitors");
  }

  return { businessId, created, existing };
}

async function main() {
  const args = process.argv.slice(2);
  const production = args.includes("--yes-i-mean-production");
  const owner = args.find((a) => !a.startsWith("--"));
  if (!owner) {
    console.error("Usage: npx tsx shell/scripts/seed-demo.ts <ownerUserId> [--yes-i-mean-production]");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL || LOCAL_URL;
  try {
    assertSafeDatabase(url, production);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const sql = postgres(url, { max: 3, onnotice: () => {} });
  try {
    const [{ ok }] = await sql<{ ok: boolean }[]>`SELECT to_regclass('public.businesses') IS NOT NULL AS ok`;
    if (!ok) throw new Error("The database has no shell tables yet. Run: cd shell && node scripts/migrate.mjs");
    await runToolMigrations(sql, TOOLS);
    const report = await seedDemo(sql, owner);
    console.log(`Demo business "${DEMO_NAME}" ready (id ${report.businessId}) for user ${owner}.`);
    console.log("created :", JSON.stringify(report.created));
    console.log("existing:", JSON.stringify(report.existing));
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
