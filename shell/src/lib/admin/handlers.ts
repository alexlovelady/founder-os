import { HttpError } from "@founderos/sdk";
import { z } from "zod";
import { PLANS } from "@/config/plans";
import { clearPlanOverride, resolvePlan, setPlanOverride } from "@/lib/billing/core";
import { recordAudit } from "@/lib/platform/audit";
import { requireAdmin, jsonError, type AdminDeps } from "./guard";
import { loadRevenue } from "./revenue-data";
import { costPercentOfRevenue } from "./revenue";
import { liftSuspension, listSuspensions, suspendUser, validateReason } from "./suspensions";
import { costLast30Days, parseUsageFilter, usageCsv, usageReport, type CsvView } from "./usage";

/** Request handlers for /api/admin/**. Each one checks the admin session itself (server-side, every request) via the injected checker. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jsonBody = (req: Request) => req.json().catch(() => null);

export async function listSuspensionsHandler(req: Request, deps: AdminDeps): Promise<Response> {
  const a = await requireAdmin(req, deps, false);
  if ("response" in a) return a.response;
  const active = new URL(req.url).searchParams.get("active") === "1";
  return Response.json({ suspensions: await listSuspensions(deps.sql(), { activeOnly: active }) });
}

export async function suspendHandler(req: Request, deps: AdminDeps, userId: string): Promise<Response> {
  const a = await requireAdmin(req, deps, true);
  if ("response" in a) return a.response;
  const body = (await jsonBody(req)) as { reason?: unknown } | null;
  const sql = deps.sql();
  const r = await suspendUser(sql, { userId, reason: String(body?.reason ?? ""), suspendedBy: a.session.user.id });
  if (!r.ok) return jsonError(r.error, r.status);
  await recordAudit(sql, { businessId: null, userId: a.session.user.id, action: "admin.user.suspend", resource: { tool: "platform", id: userId }, meta: { reason: String(body?.reason ?? "").trim() } });
  return Response.json({ ok: true });
}

export async function liftHandler(req: Request, deps: AdminDeps, userId: string): Promise<Response> {
  const a = await requireAdmin(req, deps, true);
  if ("response" in a) return a.response;
  const body = (await jsonBody(req)) as { reason?: unknown } | null;
  const v = validateReason(body?.reason);
  if (!v.ok) return jsonError(v.error, 400);
  const sql = deps.sql();
  if (!(await liftSuspension(sql, userId))) return jsonError("That user is not suspended", 404);
  await recordAudit(sql, { businessId: null, userId: a.session.user.id, action: "admin.user.lift", resource: { tool: "platform", id: userId }, meta: { reason: v.reason } });
  return Response.json({ ok: true });
}

const OverrideBody = z.object({
  plan: z.enum(PLANS.map((p) => p.id) as [string, ...string[]]),
  limits: z.record(z.string(), z.number().finite().min(0).nullable()).nullable().optional(),
  reason: z.string().trim().min(1, "A reason is required").max(500),
});

export async function setOverrideHandler(req: Request, deps: AdminDeps, businessId: string): Promise<Response> {
  const a = await requireAdmin(req, deps, true);
  if ("response" in a) return a.response;
  if (!UUID.test(businessId)) return jsonError("Not found", 404);
  const parsed = OverrideBody.safeParse(await jsonBody(req));
  if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? "Invalid input", 400);
  const sql = deps.sql();
  const [b] = await sql`SELECT 1 FROM businesses WHERE id = ${businessId}`;
  if (!b) return jsonError("Not found", 404);
  const limits = parsed.data.limits && Object.keys(parsed.data.limits).length ? parsed.data.limits : null;
  try {
    await setPlanOverride(sql, businessId, parsed.data.plan, limits, parsed.data.reason, a.session.user.id);
  } catch (e) {
    if (e instanceof HttpError) return jsonError(e.message, e.status);
    throw e;
  }
  await recordAudit(sql, { businessId, userId: a.session.user.id, action: "admin.plan_override.set", resource: { tool: "billing", id: businessId }, meta: { plan: parsed.data.plan, limits, reason: parsed.data.reason } });
  const eff = await resolvePlan(sql, businessId);
  return Response.json({ ok: true, effectivePlan: eff.plan.id, source: eff.source });
}

export async function clearOverrideHandler(req: Request, deps: AdminDeps, businessId: string): Promise<Response> {
  const a = await requireAdmin(req, deps, true);
  if ("response" in a) return a.response;
  if (!UUID.test(businessId)) return jsonError("Not found", 404);
  const sql = deps.sql();
  const [b] = await sql`SELECT 1 FROM businesses WHERE id = ${businessId}`;
  if (!b) return jsonError("Not found", 404);
  await clearPlanOverride(sql, businessId);
  await recordAudit(sql, { businessId, userId: a.session.user.id, action: "admin.plan_override.clear", resource: { tool: "billing", id: businessId } });
  const eff = await resolvePlan(sql, businessId);
  return Response.json({ ok: true, effectivePlan: eff.plan.id, source: eff.source });
}

export async function revenueHandler(req: Request, deps: AdminDeps): Promise<Response> {
  const a = await requireAdmin(req, deps, false);
  if ("response" in a) return a.response;
  return Response.json({ estimated: true, ...(await loadRevenue(deps.sql(), deps.now?.())) });
}

function filterFrom(req: Request, deps: AdminDeps) {
  const p = new URL(req.url).searchParams;
  return parseUsageFilter({ from: p.get("from"), to: p.get("to"), metric: p.get("metric") }, deps.now?.());
}

export async function usageHandler(req: Request, deps: AdminDeps): Promise<Response> {
  const a = await requireAdmin(req, deps, false);
  if ("response" in a) return a.response;
  const sql = deps.sql();
  const [report, cost, rev] = await Promise.all([usageReport(sql, filterFrom(req, deps)), costLast30Days(sql, deps.now?.()), loadRevenue(sql, deps.now?.())]);
  return Response.json({
    ...report,
    costLast30Days: cost.reported ? cost.costUsd : null,
    costPercentOfEstimatedMrr: cost.reported ? costPercentOfRevenue(cost.costUsd, rev.summary.mrr) : null,
  });
}

export async function usageExportHandler(req: Request, deps: AdminDeps): Promise<Response> {
  const a = await requireAdmin(req, deps, false);
  if ("response" in a) return a.response;
  const view = new URL(req.url).searchParams.get("view");
  const v: CsvView = view === "business" || view === "day" ? view : "metric";
  const sql = deps.sql();
  const report = await usageReport(sql, filterFrom(req, deps));
  await recordAudit(sql, { businessId: null, userId: a.session.user.id, action: "admin.usage.export", resource: { tool: "platform", id: v }, meta: { from: report.from, to: report.to, metric: report.metric } });
  return new Response(usageCsv(report, v), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="usage-${v}-${report.from}-to-${report.to}.csv"`,
      "cache-control": "no-store",
    },
  });
}
