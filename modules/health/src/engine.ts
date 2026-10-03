/**
 * Business Health rule engine: pure functions, no database.
 *
 * Health owns no data about other tools. Each rule looks at the business profile (does this matter to this business?) and at the
 * facts other tools publish (is it done?). A fact that is absent means "unknown": the other tool is not built, has no data yet, or does
 * not publish that key. Unknown is never treated as complete, and there is deliberately no numeric score.
 */
import type { BusinessProfile, Facts } from "@founderos/sdk";

export const CATEGORIES = ["Legal", "Compliance", "Finance", "Operations", "Sales", "Security"] as const;
export type Category = (typeof CATEGORIES)[number];

/** `unknown` is derived only ("not tracked yet"); the four stored/user-visible statuses are the rest. */
export const STATUSES = ["complete", "attention", "missing", "not_applicable", "unknown"] as const;
export type Status = (typeof STATUSES)[number];

export type Condition =
  | { type: "entity"; in: string[] }
  | { type: "stage"; in?: string[]; notIn?: string[] }
  | { type: "flag"; key: string }
  | { type: "employees"; min: number }
  | { type: "anyOf"; of: Condition[] };

/** How to read a fact published by another tool. */
export type Check =
  /** true = complete, false = missing. */
  | { kind: "bool"; tool: string; key: string }
  /** 0 = complete, above 0 = `otherwise` (default attention). */
  | { kind: "zero"; tool: string; key: string; otherwise?: "attention" | "missing" }
  /** above 0 = complete, 0 = missing. */
  | { kind: "positive"; tool: string; key: string }
  /** Finance runway: under `minMonths` = attention. Reads finance.latestRunwayMonths and finance.calculatorsUsed. */
  | { kind: "runway"; minMonths: number };

export interface HealthRule {
  id: string;
  category: Category;
  title: string;
  /** Plain-English why, worded cautiously where legality depends on facts we cannot know. */
  detail: string;
  /** Profile conditions: the item is shown only when none evaluates to "no". Unknown profile data keeps it visible. */
  conditions: Condition[];
  check: Check;
  /** Tool that can fix it, and where. */
  toolName: string;
  href: string;
  /** Whether the dashboard should list it from here. Off for items another tool already raises on its own. */
  surfaceInAttention: boolean;
  important?: boolean;
}

export interface Evaluation {
  status: Exclude<Status, "not_applicable">;
  /** One short sentence for the user. */
  reason: string;
}

export interface Confirmation {
  ruleId: string;
  status: "complete" | "not_applicable";
  note: string;
  confirmedAt: string;
}

export interface HealthItem {
  id: string;
  category: Category;
  title: string;
  detail: string;
  status: Status;
  /** What the facts say, before any confirmation. */
  derivedStatus: Exclude<Status, "not_applicable">;
  source: "facts" | "confirmed";
  reason: string;
  toolName: string;
  href: string;
  note: string;
  confirmedAt: string | null;
  important: boolean;
  surfaceInAttention: boolean;
}

type Tri = "yes" | "no" | "unknown";
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function evalCondition(c: Condition, p: BusinessProfile): Tri {
  switch (c.type) {
    case "entity": {
      const e = norm(p.entityType);
      if (!e || e === "not_formed" || e === "not_sure") return "unknown";
      return c.in.includes(e) ? "yes" : "no";
    }
    case "stage": {
      const s = norm(p.lifecycleStage);
      if (!s) return "unknown";
      if (c.in && !c.in.includes(s)) return "no";
      if (c.notIn?.includes(s)) return "no";
      return "yes";
    }
    case "flag": {
      const v = p.operations?.[c.key];
      return typeof v === "boolean" ? (v ? "yes" : "no") : "unknown";
    }
    case "employees":
      return p.employeeCount == null ? "unknown" : p.employeeCount >= c.min ? "yes" : "no";
    case "anyOf": {
      const rs = c.of.map((x) => evalCondition(x, p));
      if (rs.includes("yes")) return "yes";
      return rs.every((r) => r === "no") ? "no" : "unknown";
    }
  }
}

export const ruleApplies = (rule: HealthRule, p: BusinessProfile) => rule.conditions.every((c) => evalCondition(c, p) !== "no");

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const factOf = (facts: Facts, tool: string, key: string): unknown => {
  const f = facts?.[tool];
  return f && typeof f === "object" ? (f as Record<string, unknown>)[key] : undefined;
};

export const notTracked = (rule: Pick<HealthRule, "toolName">): Evaluation => ({ status: "unknown", reason: `Not tracked yet. Use ${rule.toolName} to start tracking this.` });

export function evaluate(rule: HealthRule, facts: Facts): Evaluation {
  const c = rule.check;
  if (c.kind === "runway") {
    const months = num(factOf(facts, "finance", "latestRunwayMonths"));
    const used = factOf(facts, "finance", "calculatorsUsed");
    if (months !== null) {
      return months < c.minMonths
        ? { status: "attention", reason: `Your latest runway calculation shows about ${months} months of cash. Review your plan.` }
        : { status: "complete", reason: `Your latest runway calculation shows about ${months} months of cash.` };
    }
    if (Array.isArray(used)) {
      return used.includes("runway")
        ? { status: "complete", reason: "Your latest runway calculation shows you are not burning cash." }
        : { status: "missing", reason: "No runway calculation saved yet." };
    }
    return notTracked(rule);
  }
  const v = factOf(facts, c.tool, c.key);
  if (c.kind === "bool") {
    if (typeof v !== "boolean") return notTracked(rule);
    return v ? { status: "complete", reason: "Found in your records." } : { status: "missing", reason: "Not found in your records yet." };
  }
  const n = num(v);
  if (n === null) return notTracked(rule);
  if (c.kind === "zero") {
    return n === 0 ? { status: "complete", reason: "Nothing outstanding." } : { status: c.otherwise ?? "attention", reason: `${n} outstanding.` };
  }
  return n > 0 ? { status: "complete", reason: `${n} on record.` } : { status: "missing", reason: "Nothing on record yet." };
}

/** Confirmations override what the facts say. A confirmation of a rule that does not exist (or no longer applies) is ignored by the caller. */
export function buildItem(rule: HealthRule, facts: Facts, confirmation?: Confirmation): HealthItem {
  const ev = evaluate(rule, facts);
  const base = {
    id: rule.id, category: rule.category, title: rule.title, detail: rule.detail, derivedStatus: ev.status, toolName: rule.toolName, href: rule.href,
    important: !!rule.important, surfaceInAttention: rule.surfaceInAttention,
  };
  if (confirmation) {
    const done = confirmation.status === "complete";
    return {
      ...base, status: confirmation.status, source: "confirmed", note: confirmation.note, confirmedAt: confirmation.confirmedAt,
      reason: done ? "You confirmed this is handled outside the system." : "You marked this as not applicable to your business.",
    };
  }
  return { ...base, status: ev.status, source: "facts", reason: ev.reason, note: "", confirmedAt: null };
}

export function evaluateAll(rules: HealthRule[], profile: BusinessProfile, facts: Facts, confirmations: Confirmation[] = []): HealthItem[] {
  const byRule = new Map(confirmations.map((c) => [c.ruleId, c]));
  return rules.filter((r) => ruleApplies(r, profile)).map((r) => buildItem(r, facts, byRule.get(r.id)));
}

export type Counts = Record<Status, number>;
const emptyCounts = (): Counts => ({ complete: 0, attention: 0, missing: 0, not_applicable: 0, unknown: 0 });

export function countsByCategory(items: HealthItem[]): Record<Category, Counts> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, emptyCounts()])) as Record<Category, Counts>;
  for (const i of items) out[i.category][i.status]++;
  return out;
}

const WEIGHT: Record<Status, number> = { attention: 0, missing: 1, unknown: 2, complete: 3, not_applicable: 4 };
export function sortItems(items: HealthItem[]): HealthItem[] {
  return [...items].sort((a, b) => WEIGHT[a.status] - WEIGHT[b.status] || Number(b.important) - Number(a.important) || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------- the rules

const FORMAL = ["llc", "corporation", "s_corp", "partnership"];
const NOT_IDEA: Condition = { type: "stage", notIn: ["idea"] };
const RUNNING: Condition = { type: "stage", in: ["operating", "growing"] };
const HAS_TEAM: Condition = { type: "anyOf", of: [{ type: "flag", key: "hasEmployees" }, { type: "employees", min: 1 }] };

const VAULT = { toolName: "Document vault", href: "/app/t/vault" };
const COMPLIANCE = { toolName: "Compliance Center", href: "/app/t/compliance" };
const FINANCE = { toolName: "Finance tools", href: "/app/t/finance" };
const TASKS = { toolName: "Tasks & reminders", href: "/app/t/tasks" };
const SOPS = { toolName: "SOPs & business documents", href: "/app/t/sops" };
const CRM = { toolName: "CRM", href: "/app/t/crm" };

export const RULES: HealthRule[] = [
  // Legal
  { id: "legal-formation-docs", category: "Legal", title: "Formation documents on file", detail: "Formation records (such as articles or a certificate of formation) are the starting point for most legal and bank questions.", conditions: [{ type: "entity", in: FORMAL }], check: { kind: "bool", tool: "vault", key: "hasFormationDocs" }, ...VAULT, surfaceInAttention: true },
  { id: "legal-operating-agreement", category: "Legal", title: "Operating or owner agreement", detail: "Review whether you have a written agreement between the owners. Many advisers recommend one even for small companies.", conditions: [{ type: "entity", in: ["llc", "partnership"] }], check: { kind: "bool", tool: "vault", key: "hasOperatingAgreement" }, ...VAULT, surfaceInAttention: true },
  { id: "legal-privacy-policy", category: "Legal", title: "Privacy policy", detail: "Review whether you need a privacy policy. It is often expected if you have a website or collect customers' personal data.", conditions: [{ type: "anyOf", of: [{ type: "flag", key: "collectsPersonalData" }, { type: "flag", key: "hasWebsite" }] }], check: { kind: "bool", tool: "vault", key: "hasPrivacyPolicy" }, ...VAULT, surfaceInAttention: true },
  { id: "legal-contractor-agreements", category: "Legal", title: "Contractor agreements", detail: "Review whether you have written agreements with the contractors and freelancers you use.", conditions: [{ type: "flag", key: "usesContractors" }], check: { kind: "bool", tool: "vault", key: "hasContractorAgreement" }, ...VAULT, surfaceInAttention: true },
  { id: "legal-insurance", category: "Legal", title: "Business insurance documents", detail: "Review whether your business needs insurance and, if you have it, whether the policy is on file.", conditions: [NOT_IDEA], check: { kind: "bool", tool: "vault", key: "hasInsurance" }, ...VAULT, surfaceInAttention: true },
  { id: "legal-expired-documents", category: "Legal", title: "Documents past their expiration date", detail: "Expired contracts, licenses or policies may need renewing or archiving.", conditions: [], check: { kind: "zero", tool: "vault", key: "expired" }, ...VAULT, surfaceInAttention: false },

  // Compliance
  { id: "compliance-checklist", category: "Compliance", title: "Compliance checklist set up", detail: "A checklist of filings, licenses and renewals that may apply to you, with sources to verify.", conditions: [NOT_IDEA], check: { kind: "positive", tool: "compliance", key: "itemCount" }, ...COMPLIANCE, surfaceInAttention: true },
  { id: "compliance-overdue", category: "Compliance", title: "No overdue compliance items", detail: "Overdue filings or renewals can carry penalties. Check the source for the consequences.", conditions: [NOT_IDEA], check: { kind: "zero", tool: "compliance", key: "overdue" }, ...COMPLIANCE, surfaceInAttention: false, important: true },
  { id: "compliance-confirmed", category: "Compliance", title: "Compliance items confirmed", detail: "Items you have not yet marked complete, attention or not applicable.", conditions: [NOT_IDEA], check: { kind: "zero", tool: "compliance", key: "missing", otherwise: "missing" }, ...COMPLIANCE, surfaceInAttention: false },
  { id: "compliance-ein", category: "Compliance", title: "EIN confirmation on file", detail: "Review whether your business needs an EIN, and keep the IRS confirmation with your records.", conditions: [NOT_IDEA, { type: "anyOf", of: [{ type: "entity", in: FORMAL }, HAS_TEAM] }], check: { kind: "bool", tool: "vault", key: "hasEin" }, ...VAULT, surfaceInAttention: true },

  // Finance
  { id: "finance-tax-reserve", category: "Finance", title: "Money set aside for taxes", detail: "Review whether you are setting money aside for taxes as you earn. The Finance tool has a calculator.", conditions: [RUNNING], check: { kind: "bool", tool: "finance", key: "taxReserveConfigured" }, ...FINANCE, surfaceInAttention: true },
  { id: "finance-runway", category: "Finance", title: "Cash runway checked", detail: "A rule of thumb is to keep an eye on how many months of cash you have left; under three months deserves a closer look.", conditions: [NOT_IDEA], check: { kind: "runway", minMonths: 3 }, ...FINANCE, surfaceInAttention: true },

  // Operations
  { id: "ops-overdue-tasks", category: "Operations", title: "No overdue tasks", detail: "Tasks past their due date.", conditions: [], check: { kind: "zero", tool: "tasks", key: "overdue" }, ...TASKS, surfaceInAttention: false },
  { id: "ops-sops", category: "Operations", title: "Key processes written down", detail: "Written procedures help when you are away or when someone new joins.", conditions: [{ type: "anyOf", of: [RUNNING, HAS_TEAM] }], check: { kind: "positive", tool: "sops", key: "sopCount" }, ...SOPS, surfaceInAttention: true },
  { id: "ops-customer-onboarding", category: "Operations", title: "Customer onboarding process", detail: "A repeatable way to start working with a new customer.", conditions: [{ type: "flag", key: "hasCustomers" }], check: { kind: "bool", tool: "sops", key: "hasCustomerOnboarding" }, ...SOPS, surfaceInAttention: true },
  { id: "ops-documents-organized", category: "Operations", title: "Business documents stored in one place", detail: "Contracts, policies and records you can find quickly.", conditions: [NOT_IDEA], check: { kind: "positive", tool: "vault", key: "documentCount" }, ...VAULT, surfaceInAttention: true },

  // Sales
  { id: "sales-contacts", category: "Sales", title: "Customers and leads recorded", detail: "Contacts you can follow up with.", conditions: [{ type: "stage", in: ["pre_revenue", "operating", "growing"] }], check: { kind: "positive", tool: "crm", key: "contactCount" }, ...CRM, surfaceInAttention: true },
  { id: "sales-follow-ups", category: "Sales", title: "No stale leads or deals", detail: "Leads or deals that have gone quiet may need a follow-up.", conditions: [], check: { kind: "zero", tool: "crm", key: "staleCount" }, ...CRM, surfaceInAttention: false },
  { id: "sales-pipeline", category: "Sales", title: "Open opportunities in your pipeline", detail: "Review whether you are tracking the deals you are working on.", conditions: [RUNNING], check: { kind: "positive", tool: "crm", key: "openOpportunities" }, ...CRM, surfaceInAttention: true },

  // Security
  { id: "security-incident-plan", category: "Security", title: "Incident or breach response plan", detail: "Review whether you know what to do if you lose data or an account is compromised. A short written checklist is a start.", conditions: [NOT_IDEA], check: { kind: "bool", tool: "sops", key: "hasIncidentPlan" }, ...SOPS, surfaceInAttention: true },
  { id: "security-backup-plan", category: "Security", title: "Backup and recovery plan", detail: "Review how your important files and systems would be recovered if something went wrong.", conditions: [NOT_IDEA], check: { kind: "bool", tool: "sops", key: "hasBackupPlan" }, ...SOPS, surfaceInAttention: true },
];

export const RULE_IDS = new Set(RULES.map((r) => r.id));
