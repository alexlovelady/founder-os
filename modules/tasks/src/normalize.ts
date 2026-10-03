/**
 * Other tools turn their records into tasks with a small request from the browser. Each tool author used a slightly different shape, so
 * this accepts the sensible variants and turns them into one:
 *   { title, sourceRef: {tool, id}, source? }            source is derived from the tool when missing
 *   { title, source: {tool, id}, items: [{title}] }      one task per item
 *   { tasks: [ ... ] }                                   already a list
 */
const SOURCE_BY_TOOL: Record<string, string> = {
  crm: "crm",
  compliance: "compliance",
  finance: "finance",
  vault: "document",
  sops: "document",
  marketing: "system",
  product: "system",
  competitors: "system",
  health: "system",
  founderai: "ai",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function sourceForTool(tool: string): string {
  return SOURCE_BY_TOOL[tool] ?? "system";
}

function one(raw: Obj): Obj {
  const out: Obj = { ...raw };
  // `source` given as a reference object means "this record".
  if (isObj(out.source)) {
    out.sourceRef = out.source;
    delete out.source;
  }
  const ref = out.sourceRef;
  if (typeof out.source !== "string" || !out.source) {
    out.source = isObj(ref) && typeof ref.tool === "string" ? sourceForTool(ref.tool) : "system";
  }
  delete out.items;
  return out;
}

export function normalizeFromSource(body: unknown): unknown {
  if (!isObj(body)) return body;
  if (Array.isArray(body.tasks)) return { tasks: body.tasks.map((t) => (isObj(t) ? one(t) : t)) };
  if (Array.isArray(body.items) && body.items.length > 0) {
    const { items, title, ...rest } = body;
    const parent = typeof title === "string" ? title : "";
    return {
      tasks: (items as unknown[]).map((it) => {
        const t = isObj(it) ? it : { title: String(it) };
        const itemTitle = typeof t.title === "string" ? t.title : "";
        return one({ ...rest, ...t, title: itemTitle, description: typeof t.description === "string" ? t.description : parent ? `From: ${parent}` : undefined });
      }),
    };
  }
  return one(body);
}
