/**
 * The FounderOS tool contract.
 *
 * A tool is a folder under /modules with its own code, database tables, tests and UI. It plugs into the shell by exporting one `ToolDef`.
 * Rules every tool follows:
 *  - Tools never import each other. They share data only through `attention()` and `facts()`.
 *  - Tools only touch tables named `<toolid>_*`, and every row carries `business_id`.
 *  - Tools never accept a business id or role from the client: they use `ctx`, which the shell builds from the verified session.
 *  - Mutations check `requireWrite(ctx)`.
 */
import type { ReactNode } from "react";
export { withPlatform } from "./context";
export { callToolApi, clipText } from "./actions";
export type { ToolAction, ActionRisk, ActionPreview, ActionResult, ActionRegistry, RegisteredAction } from "./actions";
import type { ActionRegistry, ToolAction } from "./actions";
import type postgres from "postgres";

export type Sql = postgres.Sql;
export type Role = "owner" | "admin" | "member" | "viewer";

export interface BusinessProfile {
  id: string;
  name: string;
  description: string;
  industry: string;
  entityType: string;
  country: string;
  state: string;
  city: string;
  website: string;
  lifecycleStage: string;
  employeeCount: number | null;
  /** Yes/no answers from onboarding: hasEmployees, usesContractors, hasCustomers, takesOnlinePayments, recurringBilling, collectsPersonalData, hasWebsite, sellsAcrossStates. */
  operations: Record<string, boolean>;
  goals: string[];
}

export interface AiRequest {
  system?: string;
  prompt: string;
  /** "fast" for short/simple work, "deep" for long or careful work. */
  tier?: "fast" | "deep";
}
export type AiStatus =
  | { state: "running" }
  | { state: "waiting"; message: string }
  | { state: "done"; text: string }
  | { state: "failed"; error: string };

export interface AiClient {
  /** False when the AI service cannot be reached or the business has no AI workspace; tools must degrade gracefully. */
  available: boolean;
  start(req: AiRequest): Promise<{ jobId: string }>;
  poll(jobId: string): Promise<AiStatus>;
}

export type Facts = Record<string, Record<string, unknown>>;

/** A record in some tool, addressed generically so any tool can link to any other. */
export interface EntityRef {
  tool: string;
  id: string;
}

export interface LinkedItem extends EntityRef {
  linkId: string;
  toolName: string;
  kind: string;
  title: string;
  href: string;
}

export interface SearchHit {
  id: string;
  title: string;
  snippet?: string;
  href: string;
}

/** Everything the platform knows about the business, assembled from every tool. Every tool receives it through `ctx.context()`. */
export interface BusinessContext {
  profile: BusinessProfile;
  /** Machine-readable facts from each tool's `facts()`. */
  facts: Facts;
  /** One short plain-text paragraph per tool from its `describe()`, plus a "legal" entry from LegalAI. Ready to put in an AI prompt. */
  summaries: Record<string, string>;
  /** Items needing attention across all tools, most urgent first. */
  attention: AttentionItem[];
  /** The profile and summaries as a single block of text for AI prompts. */
  asText(): string;
}

/** What the business's subscription allows. A limit that is missing or null means "unlimited". Plan data comes from the shell. */
export interface PlanInfo {
  id: string;
  /** e.g. { aiRequestsPerMonth: 200, storageMb: 500, teamMembers: 3 } */
  limits: Record<string, number | null>;
  /** e.g. { competitors: true, productScan: false } */
  features: Record<string, boolean>;
}

export interface NotifyInput {
  title: string;
  body?: string;
  href?: string;
  severity?: "info" | "review" | "high";
  /** Same key twice = one notification (e.g. "compliance-due-<itemId>-2026-12-01"). */
  dedupeKey?: string;
}

export interface ToolContext {
  sql: Sql;
  businessId: string;
  userId: string;
  role: Role;
  canWrite: boolean;
  business: BusinessProfile;
  ai: AiClient;
  /** Facts published by every tool's `facts()`, keyed by tool id. Computed once per request, on first call. */
  facts(): Promise<Facts>;
  /** The full business picture from all tools (profile, facts, summaries, attention). Computed once per request. */
  context(): Promise<BusinessContext>;
  /** Cross-tool links between records. Both ends must belong to this business. */
  links: {
    add(from: EntityRef, to: EntityRef, kind?: string): Promise<void>;
    remove(linkId: string): Promise<void>;
    /** Everything linked to this record, in either direction, with titles and URLs resolved by the owning tools. */
    list(ref: EntityRef): Promise<LinkedItem[]>;
  };
  /** Record something that happened (who did what to which record). Never put secrets or document contents in `meta`. */
  audit(action: string, meta?: Record<string, unknown>, resource?: EntityRef): Promise<void>;
  /** Put a message in the owner's notification inbox (and email, if enabled). Safe to call repeatedly with a dedupeKey. */
  notify(n: NotifyInput): Promise<void>;
  /** The subscription plan: use `plan.limits` / `plan.features` to gate costly or premium behaviour. */
  plan: PlanInfo;
  /** Count usage against the plan (e.g. "ai_request", "storage_bytes"). Throws HttpError 402 with a clear message when the limit is reached. */
  useQuota(metric: string, amount?: number): Promise<void>;
  /** Search every tool at once (each tool's `search()`), for global search and for the assistant. */
  search(query: string, limitPerTool?: number): Promise<{ tool: string; toolName: string; hits: SearchHit[] }[]>;
  /** Every live tool's declared `actions` (see actions.ts). Set by `withPlatform`; used by the assistant. */
  actions?: ActionRegistry;
  /** Set only while an action runs: the same key twice must have the same effect as once. */
  idempotencyKey?: string;
}

export interface AttentionItem {
  id: string;
  title: string;
  detail?: string;
  severity: "info" | "review" | "high";
  /** Where to go to deal with it (a shell path). */
  href?: string;
  dueDate?: string;
}

export interface Migration {
  /** e.g. "0001_init". Applied once, in name order, per tool. */
  name: string;
  sql: string;
}

export type ToolGroup = "legal" | "money" | "operations" | "growth" | "business";

export interface ToolDef {
  /** Lowercase letters only; also the table prefix and the URL segment (/app/t/<id>). */
  id: string;
  name: string;
  description: string;
  group: ToolGroup;
  status: "live" | "planned";
  migrations?: Migration[];
  /** Server component rendered at /app/t/<id>/<...path>. Interactive parts are client components that call /api/tools/<id>/... */
  Page?: (props: { ctx: ToolContext; path: string[] }) => Promise<ReactNode> | ReactNode;
  /** JSON/API handler for /api/tools/<id>/<...path>. Return a standard Response. */
  api?: (ctx: ToolContext, req: Request, path: string[]) => Promise<Response>;
  /** Items that deserve the owner's attention; shown on the dashboard. Keep it fast and small (<= 10 items). */
  attention?: (ctx: ToolContext) => Promise<AttentionItem[]>;
  /** Plain-English paragraph (<= 600 characters) of what this tool knows about the business right now. It feeds every other tool and the assistant. Return "" if nothing yet. */
  describe?: (ctx: ToolContext) => Promise<string>;
  /** Look up one of this tool's records by id so other tools can show and link to it. Return null if it does not exist for this business. */
  resolve?: (ctx: ToolContext, id: string) => Promise<{ title: string; href: string } | null>;
  /** Find this tool's records matching a text query (used by global search). Scope by ctx.businessId. */
  search?: (ctx: ToolContext, query: string, limit: number) => Promise<SearchHit[]>;
  /** Small facts other tools may read, e.g. { documentCategories: ["contracts"], overdueTasks: 2 }. JSON-serializable. */
  facts?: (ctx: ToolContext) => Promise<Record<string, unknown>>;
  /** Changes the assistant may PROPOSE and a person confirms (see actions.ts). Never destructive, never external or paid. */
  actions?: ToolAction[];
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function requireWrite(ctx: ToolContext): void {
  if (!ctx.canWrite) throw new HttpError(403, "Your role cannot make changes");
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** Parse a JSON request body against a zod schema (or any `{ parse }`), turning failures into a 400. */
export async function readJson<T>(req: Request, schema: { parse(v: unknown): T }): Promise<T> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  try {
    return schema.parse(body);
  } catch (e) {
    const issues = (e as { issues?: { message: string; path: (string | number)[] }[] }).issues;
    throw new HttpError(400, issues?.[0] ? `${issues[0].path.join(".") || "input"}: ${issues[0].message}` : "Invalid input");
  }
}

/** Minimal router for tool `api` handlers: match on method + path pattern like "items/:id". */
export type Handler = (ctx: ToolContext, req: Request, params: Record<string, string>) => Promise<Response>;
export function route(table: Record<string, Handler>) {
  const compiled = Object.entries(table).map(([key, handler]) => {
    const [method, pattern] = key.split(" ");
    return { method, parts: pattern.split("/").filter(Boolean), handler };
  });
  return async (ctx: ToolContext, req: Request, path: string[]): Promise<Response> => {
    try {
      for (const r of compiled) {
        if (r.method !== req.method || r.parts.length !== path.length) continue;
        const params: Record<string, string> = {};
        const ok = r.parts.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = decodeURIComponent(path[i])), true) : p === path[i]));
        if (ok) return await r.handler(ctx, req, params);
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error("tool error", e);
      return json({ error: "Something went wrong" }, 500);
    }
  };
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function uuidParam(v: string): string {
  if (!UUID_RE.test(v)) throw new HttpError(404, "Not found");
  return v;
}
