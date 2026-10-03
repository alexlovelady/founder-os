import { PLANS } from "@/config/plans";

/** Read-mostly AI admin helpers. No routing or model control lives in the shell: models are LegalAI environment variables. */

export interface LegalProbe { reachable: boolean; detail: string; ms: number | null }

/** Ask LegalAI's /healthz whether it is up. It reports only ok/not ok (no model names), so that is all this can show. Never throws. */
export async function probeLegal(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2500): Promise<LegalProbe> {
  const started = Date.now();
  try {
    const r = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/healthz`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    const ms = Date.now() - started;
    if (!r.ok) return { reachable: false, detail: `Responded with HTTP ${r.status}`, ms };
    const body = (await r.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true ? { reachable: true, detail: "Healthy", ms } : { reachable: false, detail: "Responded but did not report ok", ms };
  } catch {
    return { reachable: false, detail: "Not reachable", ms: null };
  }
}

export interface PlanAiRow { plan: string; name: string; aiTier: string; aiRequestsPerMonth: number | null }

export const planAiRows = (): PlanAiRow[] =>
  PLANS.map((p) => ({ plan: p.id, name: p.name, aiTier: p.aiTier, aiRequestsPerMonth: p.limits.aiRequestsPerMonth ?? null }));

/** Environment variables LegalAI reads for models (modules/legal/api/legalai/config.py, defaults in .env.example). */
export const LEGAL_MODEL_ENV: { name: string; purpose: string }[] = [
  { name: "FAST_MODEL", purpose: "Quick answers and the fallback for the critic and extraction roles" },
  { name: "DEEP_MODEL", purpose: "Longer, heavier reasoning (research, review, drafting)" },
  { name: "CRITIC_MODEL", purpose: "Checks answers; falls back to FAST_MODEL when empty" },
  { name: "EXTRACTION_MODEL", purpose: "Structured extraction; falls back to FAST_MODEL when empty" },
  { name: "LLM_PRIMARY_PROVIDER", purpose: "Where requests go first (local_gpu by default)" },
  { name: "LLM_FALLBACK_PROVIDER", purpose: "disabled or openai_compatible" },
  { name: "LLM_FALLBACK_MODEL", purpose: "Model name for the fallback provider" },
  { name: "EMBEDDING_PROVIDER / EMBEDDING_MODEL", purpose: "Search embeddings (external or local)" },
];
