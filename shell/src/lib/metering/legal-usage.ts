import { internalToken } from "./consume";

/** Platform-wide totals LegalAI reports about its own AI work (requests started by people inside LegalAI's pages). */
export interface LegalUsage {
  since: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  costUsd: number;
}

/**
 * Fetch LegalAI's own usage totals (all users) for the window starting at `since`, over the private network with the internal token.
 * Returns null whenever the numbers are unavailable (token unset, LegalAI down, old LegalAI without the endpoint): the admin page then says so.
 */
export async function fetchLegalUsage(since: Date, env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch): Promise<LegalUsage | null> {
  const token = internalToken(env);
  if (!token) return null;
  const base = (env.LEGAL_URL ?? "http://localhost:8000").replace(/\/+$/, "");
  try {
    const r = await fetcher(`${base}/api/internal/usage?all=1&since=${encodeURIComponent(since.toISOString())}`, {
      headers: { "x-internal-token": token },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      since: String(j.since ?? since.toISOString()), requests: n(j.requests), promptTokens: n(j.prompt_tokens),
      completionTokens: n(j.completion_tokens), tokens: n(j.tokens), costUsd: n(j.cost_usd),
    };
  } catch {
    return null;
  }
}

/** Platform totals for the last 30 days. */
export const fetchLegalUsageLast30Days = (): Promise<LegalUsage | null> => fetchLegalUsage(new Date(Date.now() - 30 * 86_400_000));
