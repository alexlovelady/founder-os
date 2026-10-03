"""One-off: add describe/resolve/search to the finance tool."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "modules/finance/src/index.tsx"
s = p.read_text(encoding="utf8")
a = "  async facts(ctx) {"
assert a in s
add = '''  async describe(ctx) {
    const rows = await ctx.sql<{ kind: string; name: string; results: Record<string, unknown> }[]>`
      SELECT kind, name, results FROM finance_calculations WHERE business_id = ${ctx.businessId} ORDER BY created_at DESC LIMIT 20`;
    if (rows.length === 0) return "";
    const runwayRow = rows.find((r) => r.kind === "runway");
    const bits: string[] = [];
    if (runwayRow) {
      const m = runwayRow.results.runwayMonths as number | null;
      bits.push(m == null ? "Latest runway calculation shows the business is not burning cash." : `Latest runway calculation: about ${m} months of cash.`);
    }
    bits.push(`Saved calculations: ${[...new Set(rows.map((r) => r.kind.replace("_", " ")))].join(", ")}.`);
    return bits.join(" ");
  },

  async resolve(ctx, id) {
    if (!UUID_RE.test(id)) return null;
    const [r] = await ctx.sql<{ name: string }[]>`SELECT name FROM finance_calculations WHERE id = ${id} AND business_id = ${ctx.businessId}`;
    return r ? { title: r.name, href: "/app/t/finance" } : null;
  },

  async search(ctx, query, limit) {
    const like = "%" + query.replace(/[%_]/g, "") + "%";
    const rows = await ctx.sql<{ id: string; name: string; kind: string }[]>`
      SELECT id, name, kind FROM finance_calculations WHERE business_id = ${ctx.businessId} AND name ILIKE ${like} ORDER BY created_at DESC LIMIT ${limit}`;
    return rows.map((r) => ({ id: r.id, title: r.name, snippet: r.kind.replace("_", " "), href: "/app/t/finance" }));
  },

'''
s = s.replace(a, add + a, 1)
s = s.replace("route, uuidParam, type AttentionItem", "route, UUID_RE, uuidParam, type AttentionItem", 1)
p.write_text(s, encoding="utf8")
print("ok")
