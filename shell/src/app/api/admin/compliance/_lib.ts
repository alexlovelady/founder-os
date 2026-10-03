/**
 * Logic behind /api/admin/compliance/**, kept out of the route files so it can be tested without Next.js: the route files only read the
 * session, the database and the network and pass them in. Every operation checks platform-admin access first (a non-admin gets the same
 * 404 as the other admin APIs) and writes an audit event for every change.
 */
import type { Sql } from "@founderos/sdk";
import { toYmd } from "@founderos/compliance/src/engine";
import { RULES } from "@founderos/compliance/src/seed";
import {
  AdminRuleError, createAdminRule, disableAdminRule, getAdminRule, listAdminRules, loadStaleQueue, markAdminRuleVerified, publishAdminRule,
  recordSourceCheck, restoreAdminRuleVersion, updateAdminRule, type AdminRuleDto,
} from "@founderos/compliance/src/admin-rules";
import { AdminRuleContent, SLUG_RE, toEngineRule } from "@founderos/compliance/src/rule-schema";
import { previewRule } from "@founderos/compliance/src/samples";
import { checkSourceUrl, type NetDeps } from "@founderos/compliance/src/source-check";
import type { Session } from "@/lib/auth/server";
import type { AuditInput } from "@/lib/platform/audit";
import { csrfBlocked, isPlatformAdmin, jsonError } from "@/lib/platform/http";

export interface Deps {
  sql: Sql;
  audit: (sql: Sql, input: AuditInput) => Promise<void>;
  net: NetDeps;
  today?: () => string;
}

/** Pure access check shared by every route: only a platform admin passes; writes also pass the cross-site (CSRF) check. */
export function guard(session: Session | null, req: Request, write: boolean): { userId: string } | { response: Response } {
  if (!isPlatformAdmin(session)) return { response: jsonError("Not found", 404) };
  if (write) {
    const blocked = csrfBlocked(req);
    if (blocked) return { response: blocked };
  }
  return { userId: session.user.id };
}

const ACTIONS = ["publish", "disable", "restore", "verify", "check"] as const;
export type RuleAction = (typeof ACTIONS)[number];
export const isRuleAction = (a: string): a is RuleAction => (ACTIONS as readonly string[]).includes(a);

const body = async (req: Request): Promise<unknown> => req.json().catch(() => null);

function fail(e: unknown): Response {
  if (e instanceof AdminRuleError) return Response.json({ error: e.message, problems: e.problems }, { status: e.status });
  throw e;
}

const audit = (d: Deps, userId: string, action: string, r: AdminRuleDto, extra: Record<string, unknown> = {}) =>
  d.audit(d.sql, {
    businessId: null, userId, action: `admin.compliance.${action}`, resource: { tool: "compliance", id: r.ruleId },
    meta: { slug: r.slug, version: r.version, status: r.status, title: r.content.title, ...extra },
  });

export async function opList(session: Session | null, req: Request, d: Deps): Promise<Response> {
  const g = guard(session, req, false);
  if ("response" in g) return g.response;
  const today = (d.today ?? (() => toYmd(new Date())))();
  const [rules, stale] = await Promise.all([listAdminRules(d.sql), loadStaleQueue(d.sql, today)]);
  const seed = RULES.map((r) => ({
    ruleId: r.id, version: r.version, title: r.title, category: r.category, jurisdiction: r.id.startsWith("state-") ? "US state" : "US federal",
    sourceTitle: r.source.title, sourceUrl: r.source.url, lastVerified: r.source.lastVerified,
  }));
  return Response.json({ today, rules, seed, stale });
}

export async function opCreate(session: Session | null, req: Request, d: Deps): Promise<Response> {
  const g = guard(session, req, true);
  if ("response" in g) return g.response;
  try {
    const rule = await createAdminRule(d.sql, g.userId, await body(req));
    await audit(d, g.userId, "rule.create", rule);
    return Response.json({ rule }, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}

export async function opGet(session: Session | null, req: Request, d: Deps, slug: string): Promise<Response> {
  const g = guard(session, req, false);
  if ("response" in g) return g.response;
  if (!SLUG_RE.test(slug)) return jsonError("Not found", 404);
  const found = await getAdminRule(d.sql, slug);
  return found ? Response.json(found) : jsonError("Not found", 404);
}

export async function opUpdate(session: Session | null, req: Request, d: Deps, slug: string): Promise<Response> {
  const g = guard(session, req, true);
  if ("response" in g) return g.response;
  if (!SLUG_RE.test(slug)) return jsonError("Not found", 404);
  try {
    const { rule, changed } = await updateAdminRule(d.sql, g.userId, slug, await body(req));
    if (changed) await audit(d, g.userId, "rule.update", rule);
    return Response.json({ rule, changed });
  } catch (e) {
    return fail(e);
  }
}

/** Live "which sample businesses would this apply to" preview. Evaluates the posted (possibly unsaved) content with the real engine. */
export async function opPreview(session: Session | null, req: Request): Promise<Response> {
  const g = guard(session, req, false);
  if ("response" in g) return g.response;
  const v = AdminRuleContent.safeParse(await body(req));
  if (!v.success) return jsonError(`${v.error.issues[0]?.path.join(".") || "input"}: ${v.error.issues[0]?.message ?? "Invalid input"}`, 400);
  return Response.json({ rows: previewRule(toEngineRule("preview", 1, v.data)) });
}

export async function opAction(session: Session | null, req: Request, d: Deps, slug: string, action: string): Promise<Response> {
  const g = guard(session, req, true);
  if ("response" in g) return g.response;
  if (!SLUG_RE.test(slug) || !isRuleAction(action)) return jsonError("Not found", 404);
  try {
    switch (action) {
      case "publish": {
        const rule = await publishAdminRule(d.sql, g.userId, slug);
        await audit(d, g.userId, "rule.publish", rule);
        return Response.json({ rule });
      }
      case "disable": {
        const rule = await disableAdminRule(d.sql, g.userId, slug);
        await audit(d, g.userId, "rule.disable", rule);
        return Response.json({ rule });
      }
      case "restore": {
        const v = Number((await body(req) as { version?: unknown } | null)?.version);
        if (!Number.isSafeInteger(v) || v < 1) return jsonError("version: choose a version to restore", 400);
        const rule = await restoreAdminRuleVersion(d.sql, g.userId, slug, v);
        await audit(d, g.userId, "rule.restore", rule, { restoredFrom: v });
        return Response.json({ rule });
      }
      case "verify": {
        const rule = await markAdminRuleVerified(d.sql, g.userId, slug, (d.today ?? (() => toYmd(new Date())))());
        await audit(d, g.userId, "rule.verify", rule, { lastVerified: rule.content.lastVerified });
        return Response.json({ rule });
      }
      case "check": {
        const found = await getAdminRule(d.sql, slug);
        if (!found) return jsonError("Not found", 404);
        if (!found.rule.content.sourceUrl) return jsonError("This rule has no source URL to check", 400);
        const result = await checkSourceUrl(found.rule.content.sourceUrl, d.net);
        const rule = await recordSourceCheck(d.sql, slug, { status: result.status, finalUrl: result.finalUrl, note: result.note });
        await audit(d, g.userId, "rule.source_check", rule, { httpStatus: result.status, ok: result.ok, blocked: result.blocked });
        return Response.json({ rule, result });
      }
    }
  } catch (e) {
    return fail(e);
  }
}
