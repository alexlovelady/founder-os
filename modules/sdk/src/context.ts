import type { AttentionItem, BusinessContext, EntityRef, Facts, LinkedItem, SearchHit, ToolContext, ToolDef } from "./index";

export type BaseContext = Omit<ToolContext, "facts" | "context" | "links" | "search">;

export interface ContextOptions {
  /** Extra summaries from services that are not tools (the shell passes LegalAI's here). */
  extraSummaries?: () => Promise<Record<string, string>>;
}

const SEVERITY = { high: 0, review: 1, info: 2 } as const;
const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch {
    return fallback;
  }
};

/**
 * Turns the identity/tenant basics into a full ToolContext: shared facts, the whole-business context, cross-tool links and search.
 * The shell and the test harness both use this, so tools behave the same in tests and in production.
 */
export function withPlatform(base: BaseContext, tools: ToolDef[], opts: ContextOptions = {}): ToolContext {
  const live = tools.filter((t) => t.status === "live");
  let factsP: Promise<Facts> | undefined;
  let contextP: Promise<BusinessContext> | undefined;
  const ctx = base as ToolContext;

  ctx.facts = () =>
    (factsP ??= (async () => {
      const out: Facts = {};
      await Promise.all(live.filter((t) => t.facts).map(async (t) => { out[t.id] = await safe(t.facts!(ctx), {}); }));
      return out;
    })());

  ctx.context = () =>
    (contextP ??= (async () => {
      const [facts, described, extra, attentionLists] = await Promise.all([
        ctx.facts(),
        Promise.all(live.filter((t) => t.describe).map(async (t) => [t.id, await safe(t.describe!(ctx), "")] as const)),
        opts.extraSummaries ? safe(opts.extraSummaries(), {}) : Promise.resolve({}),
        Promise.all(live.filter((t) => t.attention).map((t) => safe(t.attention!(ctx), [] as AttentionItem[]))),
      ]);
      const summaries: Record<string, string> = { ...extra };
      for (const [id, text] of described) if (text.trim()) summaries[id] = text.trim();
      const attention = attentionLists.flat().sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
      const p = ctx.business;
      const names = Object.fromEntries(tools.map((t) => [t.id, t.name]));
      return {
        profile: p,
        facts,
        summaries,
        attention,
        asText() {
          const ops = Object.entries(p.operations).filter(([, v]) => v).map(([k]) => k).join(", ") || "none recorded";
          const head = `Business: ${p.name}${p.description ? `. ${p.description}` : ""}\nStructure: ${p.entityType}; location: ${[p.city, p.state, p.country].filter(Boolean).join(", ")}; stage: ${p.lifecycleStage}; industry: ${p.industry || "not set"}; team size: ${p.employeeCount ?? "not set"}.\nOperations: ${ops}.\nGoals: ${p.goals.join(", ") || "none recorded"}.`;
          const body = Object.entries(summaries).map(([id, t]) => `- ${names[id] ?? id}: ${t}`).join("\n");
          return body ? `${head}\n\nWhat the other tools know:\n${body}` : head;
        },
      } satisfies BusinessContext;
    })());

  const toolById = new Map(tools.map((t) => [t.id, t]));
  const knownTool = (id: string) => toolById.has(id) || id === "legal";

  const resolveRef = async (ref: EntityRef): Promise<{ title: string; href: string; toolName: string } | null> => {
    const t = toolById.get(ref.tool);
    if (!t?.resolve) return null;
    const r = await safe(t.resolve(ctx, ref.id), null);
    return r ? { ...r, toolName: t.name } : null;
  };

  ctx.links = {
    async add(from, to, kind = "related") {
      if (!ctx.canWrite) throw new Error("Your role cannot make changes");
      if (!knownTool(from.tool) || !knownTool(to.tool)) throw new Error("Unknown tool");
      // Both ends must exist in THIS business: resolve() is scoped by ctx.businessId.
      if (!(await resolveRef(from)) || !(await resolveRef(to))) throw new Error("Cannot link records that do not exist");
      await ctx.sql`
        INSERT INTO entity_links (business_id, from_tool, from_id, to_tool, to_id, kind, created_by)
        VALUES (${ctx.businessId}, ${from.tool}, ${from.id}, ${to.tool}, ${to.id}, ${kind}, ${ctx.userId})
        ON CONFLICT DO NOTHING`;
    },
    async remove(linkId) {
      if (!ctx.canWrite) throw new Error("Your role cannot make changes");
      await ctx.sql`DELETE FROM entity_links WHERE id = ${linkId} AND business_id = ${ctx.businessId}`;
    },
    async list(ref) {
      const rows = await ctx.sql<{ id: string; from_tool: string; from_id: string; to_tool: string; to_id: string; kind: string }[]>`
        SELECT id, from_tool, from_id, to_tool, to_id, kind FROM entity_links
        WHERE business_id = ${ctx.businessId}
          AND ((from_tool = ${ref.tool} AND from_id = ${ref.id}) OR (to_tool = ${ref.tool} AND to_id = ${ref.id}))
        ORDER BY created_at DESC LIMIT 100`;
      const out: LinkedItem[] = [];
      for (const r of rows) {
        const other: EntityRef = r.from_tool === ref.tool && r.from_id === ref.id ? { tool: r.to_tool, id: r.to_id } : { tool: r.from_tool, id: r.from_id };
        const resolved = await resolveRef(other);
        if (resolved) out.push({ ...other, linkId: r.id, toolName: resolved.toolName, kind: r.kind, title: resolved.title, href: resolved.href });
      }
      return out;
    },
  };

  ctx.search = async (query, limit = 5) => {
    const q = query.trim();
    if (q.length < 2) return [];
    const results = await Promise.all(
      live.filter((t) => t.search).map(async (t) => ({ tool: t.id, toolName: t.name, hits: await safe(t.search!(ctx, q, limit), [] as SearchHit[]) })),
    );
    return results.filter((r) => r.hits.length > 0);
  };

  return ctx;
}
