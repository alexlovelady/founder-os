/**
 * Actions with confirmation: changes a tool lets the assistant PROPOSE and a person approve.
 *
 * A tool declares `actions` on its ToolDef. The Ask FounderOS assistant lists them in its prompt, the model may propose one as JSON, the
 * server validates it (`input`), computes a `preview` (no side effects) and shows it as a card. Only when a person clicks Confirm does the
 * server call `run`, as THAT user, with their role. The model never calls `run`.
 *
 * Rules for an action author:
 *  - No destructive actions (no deletes), nothing that sends an external message or spends AI/money.
 *  - `preview` reads only. It must throw (HttpError 404 is typical) when a referenced record is not in this business.
 *  - `run` calls `requireWrite(ctx)`, re-validates (the safest way is to go through the tool's own API handler with `callToolApi`, so the
 *    tool's own validation and business rules apply and nothing is duplicated), and is idempotent for the same `ctx.idempotencyKey`.
 */
import type { ZodType } from "zod";
import { HttpError, type ToolContext, type ToolDef } from "./index";

export type ActionRisk = "low" | "medium" | "high";

export interface ActionPreview {
  /** One plain sentence: what would change. */
  summary: string;
  /** Optional labelled facts shown on the card (old value, new value, ...). Plain text only. */
  details?: Record<string, string>;
}

export interface ActionResult {
  summary: string;
  /** Where to see the result (a shell path such as /app/t/tasks/t/<id>). */
  href?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each action has its own input type; the registry treats them uniformly
export interface ToolAction<I = any> {
  /** Unique within the tool, lowercase with underscores, e.g. "create_task". The assistant addresses it as "<toolId>.<id>". */
  id: string;
  /** Shown to the model and the user. One sentence. */
  description: string;
  /** Validated server side before anything is shown or run. Keep it a plain z.object so the model can be told its fields. */
  input: ZodType<I>;
  risk: ActionRisk;
  /** What would change. Side-effect free. Throws if a referenced record is not in this business. */
  preview(ctx: ToolContext, input: I): Promise<ActionPreview>;
  /** Does the work. Calls requireWrite(ctx), re-validates, and is idempotent for the same `ctx.idempotencyKey`. */
  run(ctx: ToolContext, input: I): Promise<ActionResult>;
}

export interface RegisteredAction {
  toolId: string;
  toolName: string;
  action: ToolAction;
}

export interface ActionRegistry {
  list(): RegisteredAction[];
  get(toolId: string, actionId: string): RegisteredAction | undefined;
}

/** Built by `withPlatform` from the live tools' `actions`. */
export function createActionRegistry(tools: ToolDef[]): ActionRegistry {
  const all: RegisteredAction[] = [];
  for (const t of tools) {
    if (t.status !== "live") continue;
    for (const a of t.actions ?? []) all.push({ toolId: t.id, toolName: t.name, action: a });
  }
  return {
    list: () => all,
    get: (toolId, actionId) => all.find((r) => r.toolId === toolId && r.action.id === actionId),
  };
}

/**
 * Calls one of a tool's own API routes in-process, as the given context (same role, same business), and returns the JSON body.
 * Non-2xx responses become an HttpError with the tool's own message. Use this so an action reuses the tool's validation and rules.
 */
export async function callToolApi<T = Record<string, any>>( // eslint-disable-line @typescript-eslint/no-explicit-any -- tool responses are arbitrary JSON
  tool: ToolDef,
  ctx: ToolContext,
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!tool.api) throw new HttpError(500, "This tool has no API");
  const req = new Request(`http://internal/api/tools/${tool.id}/${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await tool.api(ctx, req, path.split("?")[0].split("/").filter(Boolean));
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new HttpError(res.status, data?.error ?? "The request could not be completed");
  return data as T;
}

/** Shorten text for a preview card. */
export const clipText = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)).trimEnd() + "…");
