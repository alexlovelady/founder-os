import type { Session } from "./auth/server";
import type { Business } from "./business";

// Server-to-server address of the LegalAI service (the Railway private network in production).
const LEGAL = process.env.LEGAL_URL ?? "http://localhost:8000";

const ENTITY_MAP: Record<string, string> = {
  corporation: "delaware_c_corp",
  llc: "llc",
  s_corp: "s_corp",
  not_formed: "not_yet",
};
const STAGE_MAP: Record<string, string> = {
  idea: "Just an idea",
  forming: "Forming the company",
  pre_revenue: "Launched, no revenue yet",
  operating: "Operating with customers",
  growing: "Growing",
};

async function legal(session: Session, path: string, init: RequestInit = {}) {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { cookie: session.cookie, ...(init.headers as Record<string, string>) };
  if (method !== "GET") headers["x-csrf-token"] = session.csrf;
  return fetch(`${LEGAL}${path}`, { ...init, headers, cache: "no-store" });
}

const profileBody = (b: Business) =>
  JSON.stringify({ company_name: b.name, entity_type: ENTITY_MAP[b.entityType] ?? "other", state: b.state, stage: STAGE_MAP[b.lifecycleStage] ?? "" });

/** Push the business profile into an existing LegalAI workspace so the tool never disagrees with the dashboard. */
export async function syncLegal(session: Session, workspaceId: string, b: Business): Promise<boolean> {
  try {
    const r = await legal(session, `/api/matters/${workspaceId}/profile`, { method: "PATCH", headers: { "content-type": "application/json" }, body: profileBody(b) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Create (or find) the LegalAI company workspace for this business, so its checklist and documents start filled in. */
export async function provisionLegal(session: Session, b: Business): Promise<{ workspaceId: string } | null> {
  try {
    const r = await legal(session, "/api/onboarding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: profileBody(b),
    });
    if (r.ok) return { workspaceId: (await r.json()).matter_id };
    if (r.status === 409) {
      const list = await legal(session, "/api/matters");
      const ms = (await list.json()) as { id: string; profile?: { company?: boolean } }[];
      const m = ms.find((x) => x.profile?.company);
      if (!m) return null;
      await syncLegal(session, m.id, b);
      return { workspaceId: m.id };
    }
  } catch {
    /* module unreachable: the business is still created; linking is retried on the dashboard */
  }
  return null;
}

export interface LegalSummary {
  done: number;
  total: number;
  open: { title: string; why: string }[];
}

export async function legalSummary(session: Session, workspaceId: string): Promise<LegalSummary | null> {
  try {
    const r = await legal(session, `/api/matters/${workspaceId}/checklist`);
    if (!r.ok) return null;
    const d = (await r.json()) as { done: number; total: number; items: { title: string; why: string; status: string; optional?: boolean }[] };
    return { done: d.done, total: d.total, open: d.items.filter((i) => i.status === "todo" && !i.optional).slice(0, 4).map((i) => ({ title: i.title, why: i.why })) };
  } catch {
    return null;
  }
}
