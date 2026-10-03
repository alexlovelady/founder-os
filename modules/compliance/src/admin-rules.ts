/**
 * Platform-admin-managed compliance rules (global content, NOT business data: the one table pair in this tool without business_id).
 *
 * Lifecycle: draft -> published <-> disabled. Only published rules reach businesses (see `loadPublishedRules`, called by the checklist
 * sync). Editing a published or disabled rule bumps its version, which makes the sync refresh the wording of untouched checklist items.
 * Disabling removes untouched items that came only from the rule (the engine's existing "rule stopped applying" path).
 * Every change writes a snapshot to compliance_admin_rule_versions so any earlier version can be restored (as a new version).
 *
 * Functions take a Sql handle and an actor id; the caller (the shell's admin API) checks platform-admin access and writes the audit event.
 */
import type { Sql } from "@founderos/sdk";
import { daysBetween, toYmd, type Rule } from "./engine";
import { ADMIN_PREFIX, AdminRuleContent, CreateAdminRule, publishProblems, STALE_DAYS, toEngineRule, type AdminRuleContent as Content } from "./rule-schema";
import { RULES } from "./seed";

export type AdminRuleStatus = "draft" | "published" | "disabled";

export class AdminRuleError extends Error {
  constructor(public status: number, message: string, public problems: string[] = []) {
    super(message);
  }
}

export interface AdminRuleDto {
  slug: string;
  ruleId: string;
  version: number;
  status: AdminRuleStatus;
  enabled: boolean;
  content: Content;
  lastCheck: { at: string; status: number | null; finalUrl: string | null; note: string } | null;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface VersionDto { id: number; version: number; changedBy: string; changedAt: string; note: string; title: string; status: string }

interface Row {
  id: string; version: number; title: string; description: string; category: string; conditions: unknown; always_cautious: boolean; recommendation: string;
  cautious: string | null; priority: string; source_title: string; source_url: string; jurisdiction: string; last_verified: string | null; recurrence: string | null;
  deadline: unknown; enabled: boolean; status: AdminRuleStatus; last_checked_at: Date | null; last_status: number | null; last_checked_url: string | null;
  last_check_note: string | null; created_by: string; updated_by: string; created_at: Date; updated_at: Date;
}

const COLS = (sql: Sql) => sql`
  id, version, title, description, category, conditions, always_cautious, recommendation, cautious, priority, source_title, source_url, jurisdiction,
  to_char(last_verified, 'YYYY-MM-DD') AS last_verified, recurrence, deadline, enabled, status, last_checked_at, last_status, last_checked_url,
  last_check_note, created_by, updated_by, created_at, updated_at`;

const contentInput = (r: Row) => ({
  title: r.title, description: r.description, category: r.category, conditions: r.conditions, alwaysCautious: r.always_cautious,
  recommendation: r.recommendation, cautious: r.cautious, priority: r.priority, sourceTitle: r.source_title, sourceUrl: r.source_url,
  jurisdiction: r.jurisdiction, lastVerified: r.last_verified, recurrence: r.recurrence, deadline: r.deadline,
});
const contentOf = (r: Row): Content => AdminRuleContent.parse(contentInput(r));

const toDto = (r: Row): AdminRuleDto => ({
  slug: r.id, ruleId: `${ADMIN_PREFIX}${r.id}`, version: r.version, status: r.status, enabled: r.enabled, content: contentOf(r),
  lastCheck: r.last_checked_at ? { at: r.last_checked_at.toISOString(), status: r.last_status, finalUrl: r.last_checked_url, note: r.last_check_note ?? "" } : null,
  createdBy: r.created_by, updatedBy: r.updated_by, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(),
});

/** JSON with sorted keys, so two equal contents always compare equal. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
export const sameContent = (a: Content, b: Content) => stable(a) === stable(b);

const tx = async <T>(sql: Sql, fn: (t: Sql) => Promise<T>): Promise<T> => (await sql.begin(async (t) => fn(t as unknown as Sql))) as T;

async function snapshot(sql: Sql, r: AdminRuleDto, actor: string, note: string) {
  const snap = { version: r.version, status: r.status, content: r.content };
  await sql`INSERT INTO compliance_admin_rule_versions (rule_id, version, snapshot, changed_by, note) VALUES (${r.slug}, ${r.version}, ${sql.json(snap as never)}, ${actor}, ${note.slice(0, 300)})`;
}

async function lock(sql: Sql, slug: string): Promise<Row> {
  const [row] = await sql<Row[]>`SELECT ${COLS(sql)} FROM compliance_admin_rules WHERE id = ${slug} FOR UPDATE`;
  if (!row) throw new AdminRuleError(404, "Rule not found");
  return row;
}

async function writeContent(sql: Sql, slug: string, c: Content, version: number, actor: string): Promise<AdminRuleDto> {
  const [row] = await sql<Row[]>`
    UPDATE compliance_admin_rules SET version = ${version}, title = ${c.title}, description = ${c.description}, category = ${c.category},
      conditions = ${sql.json(c.conditions as never)}, always_cautious = ${c.alwaysCautious}, recommendation = ${c.recommendation}, cautious = ${c.cautious},
      priority = ${c.priority}, source_title = ${c.sourceTitle}, source_url = ${c.sourceUrl}, jurisdiction = ${c.jurisdiction}, last_verified = ${c.lastVerified},
      recurrence = ${c.recurrence}, deadline = ${c.deadline === null ? null : sql.json(c.deadline as never)}, updated_by = ${actor}, updated_at = now()
    WHERE id = ${slug} RETURNING ${COLS(sql)}`;
  return toDto(row);
}

// ---------------------------------------------------------------- reads

export async function listAdminRules(sql: Sql): Promise<AdminRuleDto[]> {
  const rows = await sql<Row[]>`SELECT ${COLS(sql)} FROM compliance_admin_rules ORDER BY updated_at DESC, id LIMIT 500`;
  return rows.map(toDto);
}

export async function getAdminRule(sql: Sql, slug: string): Promise<{ rule: AdminRuleDto; versions: VersionDto[] } | null> {
  const [row] = await sql<Row[]>`SELECT ${COLS(sql)} FROM compliance_admin_rules WHERE id = ${slug}`;
  if (!row) return null;
  const vs = await sql<{ id: string; version: number; changed_by: string; changed_at: Date; note: string; snapshot: { content?: { title?: string }; status?: string } }[]>`
    SELECT id, version, changed_by, changed_at, note, snapshot FROM compliance_admin_rule_versions WHERE rule_id = ${slug} ORDER BY id DESC LIMIT 100`;
  return {
    rule: toDto(row),
    versions: vs.map((v) => ({ id: Number(v.id), version: v.version, changedBy: v.changed_by, changedAt: v.changed_at.toISOString(), note: v.note, title: v.snapshot?.content?.title ?? "", status: v.snapshot?.status ?? "" })),
  };
}

/** The engine rules businesses are checked against: published AND enabled admin rules only. Rows that fail validation are skipped, never fatal. */
export async function loadPublishedRules(sql: Sql): Promise<Rule[]> {
  const rows = await sql<Row[]>`SELECT ${COLS(sql)} FROM compliance_admin_rules WHERE status = 'published' AND enabled ORDER BY id`;
  const out: Rule[] = [];
  for (const r of rows) {
    const parsed = AdminRuleContent.safeParse(contentInput(r));
    if (parsed.success) out.push(toEngineRule(r.id, r.version, parsed.data));
  }
  return out;
}

// ---------------------------------------------------------------- writes

export async function createAdminRule(sql: Sql, actor: string, input: unknown): Promise<AdminRuleDto> {
  const v = CreateAdminRule.safeParse(input);
  if (!v.success) throw new AdminRuleError(400, `${v.error.issues[0]?.path.join(".") || "input"}: ${v.error.issues[0]?.message ?? "Invalid input"}`);
  const { slug, ...c } = v.data;
  return tx(sql, async (t) => {
    const [exists] = await t`SELECT 1 FROM compliance_admin_rules WHERE id = ${slug}`;
    if (exists) throw new AdminRuleError(409, "A rule with that id already exists");
    await t`
      INSERT INTO compliance_admin_rules (id, version, title, description, category, conditions, always_cautious, recommendation, cautious, priority, source_title, source_url,
        jurisdiction, last_verified, recurrence, deadline, enabled, status, created_by, updated_by)
      VALUES (${slug}, 1, ${c.title}, ${c.description}, ${c.category}, ${t.json(c.conditions as never)}, ${c.alwaysCautious}, ${c.recommendation}, ${c.cautious}, ${c.priority},
        ${c.sourceTitle}, ${c.sourceUrl}, ${c.jurisdiction}, ${c.lastVerified}, ${c.recurrence}, ${c.deadline === null ? null : t.json(c.deadline as never)}, false, 'draft', ${actor}, ${actor})`;
    const [row] = await t<Row[]>`SELECT ${COLS(t)} FROM compliance_admin_rules WHERE id = ${slug}`;
    const dto = toDto(row);
    await snapshot(t, dto, actor, "created as draft");
    return dto;
  });
}

/** Edit the content. Drafts stay on their version; a published or disabled rule moves to a new version (and a published one must stay publishable). */
export async function updateAdminRule(sql: Sql, actor: string, slug: string, input: unknown): Promise<{ rule: AdminRuleDto; changed: boolean }> {
  const v = AdminRuleContent.safeParse(input);
  if (!v.success) throw new AdminRuleError(400, `${v.error.issues[0]?.path.join(".") || "input"}: ${v.error.issues[0]?.message ?? "Invalid input"}`);
  return tx(sql, async (t) => {
    const cur = toDto(await lock(t, slug));
    if (sameContent(cur.content, v.data)) return { rule: cur, changed: false };
    if (cur.status === "published") {
      const problems = publishProblems(slug, v.data);
      if (problems.length) throw new AdminRuleError(400, "A published rule must stay complete: " + problems[0], problems);
    }
    const version = cur.status === "draft" ? cur.version : cur.version + 1;
    const rule = await writeContent(t, slug, v.data, version, actor);
    await snapshot(t, rule, actor, cur.status === "draft" ? "draft edited" : `edited (v${cur.version} -> v${version})`);
    return { rule, changed: true };
  });
}

export async function publishAdminRule(sql: Sql, actor: string, slug: string): Promise<AdminRuleDto> {
  return tx(sql, async (t) => {
    const cur = toDto(await lock(t, slug));
    if (cur.status === "published") return cur;
    const problems = publishProblems(slug, cur.content);
    if (problems.length) throw new AdminRuleError(400, "Cannot publish: " + problems[0], problems);
    // A republish after a disable is a new version so untouched items get refreshed wording.
    const version = cur.status === "disabled" ? cur.version + 1 : cur.version;
    const [row] = await t<Row[]>`
      UPDATE compliance_admin_rules SET status = 'published', enabled = true, version = ${version}, updated_by = ${actor}, updated_at = now()
      WHERE id = ${slug} RETURNING ${COLS(t)}`;
    const dto = toDto(row);
    await snapshot(t, dto, actor, cur.status === "disabled" ? "republished" : "published");
    return dto;
  });
}

export async function disableAdminRule(sql: Sql, actor: string, slug: string): Promise<AdminRuleDto> {
  return tx(sql, async (t) => {
    const cur = toDto(await lock(t, slug));
    if (cur.status === "disabled") return cur;
    if (cur.status !== "published") throw new AdminRuleError(400, "Only a published rule can be disabled");
    const [row] = await t<Row[]>`
      UPDATE compliance_admin_rules SET status = 'disabled', enabled = false, updated_by = ${actor}, updated_at = now()
      WHERE id = ${slug} RETURNING ${COLS(t)}`;
    const dto = toDto(row);
    await snapshot(t, dto, actor, "disabled");
    return dto;
  });
}

/** Re-apply the content of an earlier version as a NEW version (history is never rewritten). */
export async function restoreAdminRuleVersion(sql: Sql, actor: string, slug: string, version: number): Promise<AdminRuleDto> {
  return tx(sql, async (t) => {
    const cur = toDto(await lock(t, slug));
    const [snap] = await t<{ snapshot: { content?: unknown } }[]>`SELECT snapshot FROM compliance_admin_rule_versions WHERE rule_id = ${slug} AND version = ${version} ORDER BY id DESC LIMIT 1`;
    if (!snap) throw new AdminRuleError(404, "That version does not exist");
    const parsed = AdminRuleContent.safeParse(snap.snapshot.content);
    if (!parsed.success) throw new AdminRuleError(400, "That version can no longer be restored: " + (parsed.error.issues[0]?.message ?? "invalid"));
    if (sameContent(cur.content, parsed.data)) return cur;
    if (cur.status === "published") {
      const problems = publishProblems(slug, parsed.data);
      if (problems.length) throw new AdminRuleError(400, "That version is not publishable: " + problems[0], problems);
    }
    const next = cur.status === "draft" ? cur.version : cur.version + 1;
    const rule = await writeContent(t, slug, parsed.data, next, actor);
    await snapshot(t, rule, actor, `restored from v${version}`);
    return rule;
  });
}

/** "I checked the source today." Moves a published rule to a new version so the new date reaches checklist items. */
export async function markAdminRuleVerified(sql: Sql, actor: string, slug: string, today = toYmd(new Date())): Promise<AdminRuleDto> {
  return tx(sql, async (t) => {
    const cur = toDto(await lock(t, slug));
    if (cur.content.lastVerified === today) return cur;
    const content = { ...cur.content, lastVerified: today };
    const version = cur.status === "draft" ? cur.version : cur.version + 1;
    const rule = await writeContent(t, slug, content, version, actor);
    await snapshot(t, rule, actor, `marked verified ${today}`);
    return rule;
  });
}

export interface SourceCheckRecord { status: number | null; finalUrl: string | null; note: string }

/** Stores the outcome of a source health check. Not a content change: no new version. */
export async function recordSourceCheck(sql: Sql, slug: string, r: SourceCheckRecord): Promise<AdminRuleDto> {
  const [row] = await sql<Row[]>`
    UPDATE compliance_admin_rules SET last_checked_at = now(), last_status = ${r.status}, last_checked_url = ${r.finalUrl}, last_check_note = ${r.note.slice(0, 300)}
    WHERE id = ${slug} RETURNING ${COLS(sql)}`;
  if (!row) throw new AdminRuleError(404, "Rule not found");
  return toDto(row);
}

// ---------------------------------------------------------------- stale queue (spec 62)

export interface StaleEntry {
  ruleId: string;
  title: string;
  origin: "seed" | "admin";
  /** Admin rules only. */
  status: AdminRuleStatus | null;
  sourceTitle: string;
  sourceUrl: string;
  lastVerified: string | null;
  /** null when the rule has never been verified. */
  ageDays: number | null;
}

export interface StaleInput { ruleId: string; title: string; origin: "seed" | "admin"; status: AdminRuleStatus | null; sourceTitle: string; sourceUrl: string; lastVerified: string | null }

/** Rules whose last_verified is older than `days` (or missing), oldest first, never-verified first. Disabled admin rules are skipped. Pure. */
export function staleQueue(entries: StaleInput[], today: string, days = STALE_DAYS): StaleEntry[] {
  return entries
    .filter((e) => e.status !== "disabled")
    .map((e): StaleEntry => ({ ...e, ageDays: e.lastVerified ? daysBetween(e.lastVerified, today) : null }))
    .filter((e) => e.ageDays === null || e.ageDays > days)
    .sort((a, b) => (a.lastVerified ?? "").localeCompare(b.lastVerified ?? "") || a.ruleId.localeCompare(b.ruleId));
}

/** Seed (code) rules plus admin rules in one list, ready for `staleQueue`. */
export async function staleInputs(sql: Sql): Promise<StaleInput[]> {
  const seed = RULES.map((r): StaleInput => ({ ruleId: r.id, title: r.title, origin: "seed", status: null, sourceTitle: r.source.title, sourceUrl: r.source.url, lastVerified: r.source.lastVerified }));
  const admin = (await listAdminRules(sql)).map((r): StaleInput => ({ ruleId: r.ruleId, title: r.content.title, origin: "admin", status: r.status, sourceTitle: r.content.sourceTitle, sourceUrl: r.content.sourceUrl, lastVerified: r.content.lastVerified }));
  return [...seed, ...admin];
}

export async function loadStaleQueue(sql: Sql, today = toYmd(new Date())): Promise<StaleEntry[]> {
  return staleQueue(await staleInputs(sql), today);
}
