/**
 * Validation for platform-admin-managed rules. The condition language is exactly the engine's `Condition` type; this file only adds a
 * runtime (zod) check for it, so a rule an admin saves can never contain a condition the engine cannot evaluate.
 */
import { z } from "zod";
import { CATEGORIES, isValidDate, RECURRENCES, toYmd, validateRules, type Condition, type Rule } from "./engine";
import { STATE_PORTALS } from "./states";

export const ADMIN_PREFIX = "admin:";
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
export const STALE_DAYS = 180;
export const MAX_CONDITIONS = 12;
const MAX_DEPTH = 3;

const STATE_CODES = new Set(STATE_PORTALS.map((s) => s.code));
const text = (max: number) => z.string().trim().min(1).max(max);
const list = z.array(text(80)).min(1).max(40);

const simple = [
  z.object({ type: z.literal("country"), in: list }).strict(),
  z.object({ type: z.literal("state"), is: z.string().trim().toUpperCase().refine((c) => STATE_CODES.has(c), "Use a two-letter US state code such as NC") }).strict(),
  z.object({ type: z.literal("entity"), in: list }).strict(),
  z
    .object({ type: z.literal("stage"), in: list.optional(), notIn: list.optional() })
    .strict()
    .refine((c) => c.in !== undefined || c.notIn !== undefined, "A stage condition needs 'in' or 'notIn'"),
  z.object({ type: z.literal("flag"), key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/, "Use a flag name such as usesContractors"), value: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("employees"), min: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ type: z.literal("industry"), any: list }).strict(),
  z.object({ type: z.literal("industryKnown") }).strict(),
] as const;

function conditionAt(depth: number): z.ZodType<Condition> {
  const anyOf = z.object({
    type: z.literal("anyOf"),
    of: depth >= MAX_DEPTH ? z.never() : z.array(z.lazy(() => conditionAt(depth + 1))).min(1).max(MAX_CONDITIONS),
  }).strict();
  return z.union([...simple, anyOf]) as unknown as z.ZodType<Condition>;
}

/** The engine's condition language, as a zod schema (anyOf nests up to three levels). */
export const ConditionSchema = conditionAt(0);
export const ConditionsSchema = z.array(ConditionSchema).max(MAX_CONDITIONS);

/** An https address with a real-looking host and no credentials. */
export function isHttpsUrl(u: string): boolean {
  if (u.length > 2000) return false;
  try {
    const p = new URL(u);
    return p.protocol === "https:" && !p.username && !p.password && p.hostname.includes(".") && !/\s/.test(u);
  } catch {
    return false;
  }
}

const httpsUrl = z.string().trim().max(2000).refine((u) => u === "" || isHttpsUrl(u), "Use a full web address starting with https://");
const dateStr = z.string().refine(isValidDate, "Use a date like 2026-12-31");

/** The editable content of an admin rule. Drafts may be incomplete (no source yet); publishing runs `publishProblems`. */
export const AdminRuleContent = z
  .object({
    title: text(200),
    description: z.string().trim().max(2000).default(""),
    category: z.enum(CATEGORIES),
    conditions: ConditionsSchema,
    alwaysCautious: z.boolean().default(false),
    recommendation: z.string().trim().max(1000).default(""),
    cautious: z.string().trim().max(1000).nullable().default(null),
    priority: z.enum(["high", "normal"]).default("normal"),
    sourceTitle: z.string().trim().max(200).default(""),
    sourceUrl: httpsUrl.default(""),
    jurisdiction: z.string().trim().min(1).max(100).default("US"),
    lastVerified: dateStr.nullable().default(null),
    recurrence: z.enum(RECURRENCES).nullable().default(null),
    deadline: z
      .object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) })
      .strict()
      .refine((d) => isValidDate(`2024-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`), "That day does not exist in that month")
      .nullable()
      .default(null),
  })
  .strict();
export type AdminRuleContentInput = z.input<typeof AdminRuleContent>;
export type AdminRuleContent = z.output<typeof AdminRuleContent>;

export const CreateAdminRule = AdminRuleContent.extend({ slug: z.string().trim().toLowerCase().regex(SLUG_RE, "Use lowercase letters, numbers and dashes (2 to 61 characters)") }).strict();

/** The engine Rule built from stored content. `id` is namespaced so it can never collide with a seed rule. */
export function toEngineRule(slug: string, version: number, c: AdminRuleContent): Rule {
  return {
    id: `${ADMIN_PREFIX}${slug}`,
    version,
    title: c.title,
    description: c.description,
    category: c.category,
    conditions: c.conditions,
    alwaysCautious: c.alwaysCautious || undefined,
    recommendation: c.recommendation,
    cautious: c.cautious ?? undefined,
    source: { title: c.sourceTitle, url: c.sourceUrl, lastVerified: c.lastVerified },
    recurrence: c.recurrence,
    deadline: c.deadline,
    priority: c.priority,
  };
}

/**
 * Everything that must be true before a rule may be published (spec 62: no untraceable compliance content).
 * Returns human-readable problems; an empty list means publishable.
 */
export function publishProblems(slug: string, c: AdminRuleContent, today = toYmd(new Date())): string[] {
  const out: string[] = [];
  if (!c.sourceUrl) out.push("A source URL is required to publish");
  else if (!isHttpsUrl(c.sourceUrl)) out.push("The source URL must be an https address");
  if (!c.sourceTitle) out.push("A source title is required to publish");
  if (!c.lastVerified) out.push("A last-verified date is required to publish");
  else if (c.lastVerified > today) out.push("The last-verified date cannot be in the future");
  if (!c.recommendation) out.push("Recommendation wording is required to publish");
  if (c.conditions.length === 0) out.push("Add at least one condition (a rule with none would apply to every business)");
  out.push(...validateRules([toEngineRule(slug, 1, c)]).map((p) => p.replace(`${ADMIN_PREFIX}${slug}: `, "")));
  return [...new Set(out)];
}
