/**
 * Compliance rules engine: pure functions, no database, no clock except where a `today` argument is passed.
 *
 * A rule never states a legal fact by itself. It says "if the business looks like THIS, show THIS reminder", and it always carries
 * the source the reminder is based on. When we cannot be sure a rule applies (profile data missing, or the rule depends on facts we do
 * not hold) the wording switches to a cautious "Review whether ..." form.
 */
import type { BusinessProfile } from "@founderos/sdk";

export const CATEGORIES = [
  "entity filing",
  "annual reports",
  "income tax",
  "licenses",
  "registered agent",
  "sales tax",
  "payroll",
  "contractor documentation",
  "insurance",
  "website privacy",
  "security",
  "industry-specific",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export const STATUSES = ["complete", "attention", "missing", "not_applicable"] as const;
export type ItemStatus = (typeof STATUSES)[number];

export const RECURRENCES = ["monthly", "quarterly", "yearly"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

export type Tri = "yes" | "no" | "unknown";

/** Conditions are data, not code, so the rule set can be extended or loaded from elsewhere later. All conditions of a rule must hold. */
export type Condition =
  | { type: "country"; in: string[] }
  /** Strict: the profile state must be this one. A blank state never matches (state rules are simply not generated). */
  | { type: "state"; is: string }
  | { type: "entity"; in: string[] }
  | { type: "stage"; in?: string[]; notIn?: string[] }
  | { type: "flag"; key: string; value?: boolean }
  | { type: "employees"; min: number }
  /** Case-insensitive substring match against the industry text. Blank industry is "unknown". */
  | { type: "industry"; any: string[] }
  | { type: "industryKnown" }
  | { type: "anyOf"; of: Condition[] };

export interface RuleSource {
  title: string;
  url: string;
  /** Date (YYYY-MM-DD) the URL was last loaded and checked by a person or script, or null if it could not be loaded automatically. */
  lastVerified: string | null;
}

export interface Rule {
  id: string;
  /** Bump when the text, source or conditions change; existing checklist items are refreshed to the new wording (status and notes are kept). */
  version: number;
  title: string;
  description: string;
  category: Category;
  conditions: Condition[];
  /** True when applicability depends on facts we cannot know (thresholds, state specifics): the wording is always cautious. */
  alwaysCautious?: boolean;
  /** Wording used when the rule certainly applies. */
  recommendation: string;
  /** Wording used when applicability is uncertain. Defaults to "Review whether this applies: <title>". */
  cautious?: string;
  source: RuleSource;
  recurrence: Recurrence | null;
  /** Fixed calendar deadline, only if the source states one. Our seed rules leave this null: users set their own dates. */
  deadline?: { month: number; day: number } | null;
  priority: "high" | "normal";
}

export interface RuleMatch {
  rule: Rule;
  certainty: "certain" | "uncertain";
  recommendation: string;
}

const US = ["united states", "united states of america", "usa", "us", "u.s.", "u.s.a."];
export const isUnitedStates = (country: string) => US.includes(country.trim().toLowerCase());

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export function stateCodeOf(profileState: string): string | null {
  const v = norm(profileState);
  return v || null;
}

/** Evaluate one condition against a business profile. `stateResolver` maps a profile state string to a 2-letter code (or null). */
export function evalCondition(c: Condition, p: BusinessProfile, stateResolver: (s: string) => string | null = (s) => s.toUpperCase()): Tri {
  switch (c.type) {
    case "country": {
      if (!norm(p.country)) return "unknown";
      return c.in.map((x) => x.toLowerCase()).includes(norm(p.country)) || (c.in.includes("US") && isUnitedStates(p.country)) ? "yes" : "no";
    }
    case "state":
      return stateResolver(p.state) === c.is ? "yes" : "no";
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
      if (typeof v !== "boolean") return "unknown";
      return v === (c.value ?? true) ? "yes" : "no";
    }
    case "employees": {
      if (p.employeeCount == null) return "unknown";
      return p.employeeCount >= c.min ? "yes" : "no";
    }
    case "industry": {
      const i = norm(p.industry);
      if (!i) return "unknown";
      return c.any.some((k) => i.includes(k.toLowerCase())) ? "yes" : "no";
    }
    case "industryKnown":
      return norm(p.industry) ? "yes" : "no";
    case "anyOf": {
      const rs = c.of.map((x) => evalCondition(x, p, stateResolver));
      if (rs.includes("yes")) return "yes";
      return rs.every((r) => r === "no") ? "no" : "unknown";
    }
  }
}

export const DEFAULT_CAUTIOUS = (title: string) => `Review whether this applies to your business: ${title}.`;

export function matchRule(rule: Rule, p: BusinessProfile, stateResolver?: (s: string) => string | null): RuleMatch | null {
  let unknown = false;
  for (const c of rule.conditions) {
    const r = evalCondition(c, p, stateResolver);
    if (r === "no") return null;
    if (r === "unknown") unknown = true;
  }
  const certainty = unknown || rule.alwaysCautious ? "uncertain" : "certain";
  // alwaysCautious rules already carry cautious wording in `recommendation`.
  const recommendation = certainty === "certain" || rule.alwaysCautious ? rule.recommendation : rule.cautious ?? DEFAULT_CAUTIOUS(rule.title);
  return { rule, certainty, recommendation };
}

export function applicableRules(rules: Rule[], p: BusinessProfile, stateResolver?: (s: string) => string | null): RuleMatch[] {
  return rules.map((r) => matchRule(r, p, stateResolver)).filter((m): m is RuleMatch => m !== null);
}

// ---------------------------------------------------------------- dates

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}
export const toYmd = (d: Date) => d.toISOString().slice(0, 10);
const fromYmd = (s: string) => new Date(`${s}T00:00:00Z`);

export function addMonthsYmd(ymd: string, months: number): string {
  const d = fromYmd(ymd);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return toYmd(d);
}

const STEP: Record<Recurrence, number> = { monthly: 1, quarterly: 3, yearly: 12 };

/** The date after `due` in a recurring cycle, always strictly after `today` (so a long-overdue item does not renew into the past). */
export function nextDue(due: string, recurrence: Recurrence, today: string): string {
  let d = addMonthsYmd(due, STEP[recurrence]);
  let guard = 0;
  while (d <= today && guard++ < 600) d = addMonthsYmd(d, STEP[recurrence]);
  return d;
}

/** Next occurrence of a rule's fixed deadline on or after `today`, or null when the rule has none. */
export function nextRuleDeadline(rule: Pick<Rule, "deadline">, today: string): string | null {
  if (!rule.deadline) return null;
  const y = +today.slice(0, 4);
  for (const year of [y, y + 1]) {
    const ymd = `${year}-${String(rule.deadline.month).padStart(2, "0")}-${String(rule.deadline.day).padStart(2, "0")}`;
    if (isValidDate(ymd) && ymd >= today) return ymd;
  }
  return null;
}

export const daysBetween = (fromDate: string, toDate: string) => Math.round((fromYmd(toDate).getTime() - fromYmd(fromDate).getTime()) / 86400000);

export type DueState = "overdue" | "soon" | "later" | "none";
export const SOON_DAYS = 30;
export function dueState(status: ItemStatus, due: string | null, today: string): DueState {
  if (!due || status === "complete" || status === "not_applicable") return "none";
  if (due < today) return "overdue";
  return daysBetween(today, due) <= SOON_DAYS ? "soon" : "later";
}

// ---------------------------------------------------------------- checklist sync

export interface ExistingItem {
  id: string;
  ruleId: string | null;
  ruleVersion: number | null;
  status: ItemStatus;
  userEdited: boolean;
  uncertain: boolean;
}

export interface SyncPlan {
  insert: RuleMatch[];
  /** Rule items whose wording should be refreshed (id + the match that now applies). Status, notes and dates are never touched. */
  refresh: { id: string; match: RuleMatch }[];
  /** Untouched rule items that no longer apply to the profile. Items the user has touched, or marked not applicable, are kept. */
  remove: string[];
}

/**
 * Idempotent plan to bring a business's stored checklist in line with the rules that currently apply.
 *  - never creates a second item for the same rule (even one marked not_applicable: it is not resurrected);
 *  - never deletes anything the user touched.
 */
export function planSync(matches: RuleMatch[], existing: ExistingItem[]): SyncPlan {
  const byRule = new Map<string, ExistingItem>();
  for (const e of existing) if (e.ruleId) byRule.set(e.ruleId, e);
  const applicable = new Set(matches.map((m) => m.rule.id));
  const plan: SyncPlan = { insert: [], refresh: [], remove: [] };
  for (const m of matches) {
    const e = byRule.get(m.rule.id);
    if (!e) plan.insert.push(m);
    else if (e.ruleVersion !== m.rule.version || e.uncertain !== (m.certainty === "uncertain")) plan.refresh.push({ id: e.id, match: m });
  }
  for (const e of existing) {
    if (e.ruleId && !applicable.has(e.ruleId) && !e.userEdited && e.status === "missing") plan.remove.push(e.id);
  }
  return plan;
}

/** Checks that a rule set is internally consistent (used by tests and when loading extra rule sets). */
export function validateRules(rules: Rule[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of rules) {
    if (seen.has(r.id)) problems.push(`duplicate id ${r.id}`);
    seen.add(r.id);
    if (!/^https:\/\//.test(r.source.url)) problems.push(`${r.id}: source url must be https`);
    if (!r.source.title) problems.push(`${r.id}: missing source title`);
    if (r.source.lastVerified && !isValidDate(r.source.lastVerified)) problems.push(`${r.id}: bad lastVerified`);
    if (!CATEGORIES.includes(r.category)) problems.push(`${r.id}: unknown category`);
    if (r.recurrence && !RECURRENCES.includes(r.recurrence)) problems.push(`${r.id}: unknown recurrence`);
    if (r.deadline && !isValidDate(`2024-${String(r.deadline.month).padStart(2, "0")}-${String(r.deadline.day).padStart(2, "0")}`)) problems.push(`${r.id}: bad deadline`);
    if (/\b(you must|is required|are required|illegal)\b/i.test(r.recommendation) && r.alwaysCautious) problems.push(`${r.id}: cautious rule uses assertive wording`);
  }
  return problems;
}
