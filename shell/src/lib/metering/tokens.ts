import type { Sql } from "@founderos/sdk";

export interface AiUsage {
  jobId: string;
  promptTokens: number;
  completionTokens: number;
  model: string | null;
}

export interface TokenRecordInput extends AiUsage {
  businessId: string;
  userId: string | null;
}

const whole = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Record the tokens a tool's AI job used, once per job (unique on business + metric + external_id, see migration 0010).
 * The local GPU has no per-token cost, so the estimated cost is 0 (the admin page says so). Returns true when a row was written.
 */
export async function recordToolTokens(sql: Sql, u: TokenRecordInput): Promise<boolean> {
  const total = whole(u.promptTokens) + whole(u.completionTokens);
  if (total <= 0 || !u.jobId) return false;
  const rows = await sql<{ id: string }[]>`
    INSERT INTO usage_events (business_id, user_id, metric, quantity, model, estimated_cost_usd, external_id)
    VALUES (${u.businessId}, ${u.userId}, 'ai_tokens', ${total}, ${u.model ?? null}, 0, ${`job:${u.jobId}`})
    ON CONFLICT (business_id, metric, external_id) WHERE external_id IS NOT NULL DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Pulls the usage fields out of a LegalAI job JSON (`result.prompt_tokens`, `result.completion_tokens`, `result.model`/`model_used`). */
export function usageFromJob(jobId: string, j: { result?: Record<string, unknown> | null; model_used?: unknown }): AiUsage {
  const r = (j.result ?? {}) as Record<string, unknown>;
  const model = typeof r.model === "string" && r.model ? r.model : typeof j.model_used === "string" && j.model_used ? j.model_used : null;
  return { jobId, promptTokens: whole(r.prompt_tokens), completionTokens: whole(r.completion_tokens), model };
}
