import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, FakeAi, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { cleanAiText } from "../src/ai";
import { detectKeywords, nextReviewDate } from "../src/facts";
import { blocksToHtml, extractSteps, parseMarkdown, toChecklist } from "../src/markdown";
import { formatSop, missingSections, toItems } from "../src/sop";
import { generateDocument, quoteTotals } from "../src/templates";
import { tool } from "../src/index";

describe("SOP formatter (deterministic)", () => {
  const input = { name: "Handle a refund", goal: "Refund customers fairly.", performer: "Office manager", tools: "Stripe, Email", steps: "1. Find the order\n- Check the policy\nIssue the refund", result: "Customer is refunded in 3 days", exceptions: "Order older than 90 days" };
  it("produces every standard section, in order", () => {
    const { title, body } = formatSop(input, { date: "2026-01-02" });
    expect(title).toBe("Handle a refund");
    const heads = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(heads).toEqual(["Purpose", "Owner", "Frequency", "Required Tools", "Prerequisites", "Procedure", "Quality Checks", "Exceptions", "Escalation", "Revision History"]);
    expect(body).toContain("1. Find the order\n2. Check the policy\n3. Issue the refund");
    expect(body).toContain("- [ ] Expected result achieved: Customer is refunded in 3 days");
    expect(body).toContain("- v1 (2026-01-02): Initial version");
    expect(missingSections(body)).toEqual([]);
  });
  it("is stable and marks blanks as placeholders", () => {
    expect(formatSop(input, { date: "d" })).toEqual(formatSop(input, { date: "d" }));
    const empty = formatSop({}, { date: "" });
    expect(empty.title).toBe("Untitled procedure");
    expect(empty.body).toContain("## Frequency\n[●TO FILL IN]");
  });
  it("splits list text sensibly", () => {
    expect(toItems("a, b ,c")).toEqual(["a", "b", "c"]);
    expect(toItems("- x\n2) y\n\n")).toEqual(["x", "y"]);
  });
});

describe("markdown", () => {
  it("never emits raw html from the document", () => {
    const html = blocksToHtml(parseMarkdown("# <script>alert(1)</script>\n\n[x](javascript:alert(1)) and **b** <img src=x onerror=1>"));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;script&gt;");
  });
  it("extracts steps from Procedure and builds a checklist", () => {
    const md = formatSop({ name: "X", steps: "one\ntwo" }).body;
    expect(extractSteps(md)).toEqual(["one", "two"]);
    expect(toChecklist("X", md)).toBe("# Checklist: X\n\n- [ ] one\n- [ ] two\n");
  });
  it("cleans AI chatter", () => {
    expect(cleanAiText("Sure! Here is your SOP:\n\n# T\n\n## Purpose\nx\n\nLet me know if you need more.")).toBe("# T\n\n## Purpose\nx");
    expect(cleanAiText("```markdown\n# T\n```")).toBe("# T");
  });
});

describe("templates and facts helpers", () => {
  it("quote totals are computed and bad lines reported", () => {
    const q = quoteTotals("Faucet | 2 | 85.50\nLabor | 1.5 | $100\nbroken line", "10");
    expect(q).toMatchObject({ subtotal: 321, tax: 32.1, total: 353.1 });
    expect(q.bad).toEqual(["broken line"]);
  });
  it("templates fill from the business profile and use placeholders", () => {
    const d = generateDocument("proposal", { client: "Acme" }, { name: "Test Co", city: "Charlotte", state: "NC" }, "2026-01-01");
    expect(d.title).toContain("Acme");
    expect(d.body).toContain("**Test Co**");
    expect(d.body).toContain("[●TO FILL IN]");
    expect(generateDocument("meeting_agenda", { meeting: "Weekly", topics: "Sales | 10\nOps" }, { name: "T" }, "d").body).toContain("1. Sales (10 min)\n2. Ops");
  });
  it("detects keywords and review dates", () => {
    expect(detectKeywords(["Customer onboarding", "Data backup procedure", "Incident response"])).toEqual({ hasCustomerOnboarding: true, hasIncidentPlan: true, hasBackupPlan: true });
    expect(detectKeywords(["Opening"])).toEqual({ hasCustomerOnboarding: false, hasIncidentPlan: false, hasBackupPlan: false });
    expect(nextReviewDate("quarterly", "2026-01-31", "2025-01-01")).toBe("2026-05-01");
    expect(nextReviewDate("yearly", null, "2025-03-04T00:00:00Z")).toBe("2026-03-04");
    expect(nextReviewDate("none", null, "2025-03-04")).toBeNull();
  });
});

describe("sops tool (database)", () => {
  let env: TestEnv;
  let id = "";
  beforeAll(async () => {
    env = await makeTestEnv([tool], { ai: new FakeAi(["Sure, here you go:\n\n# Draft\n\n## Purpose\nBecause. [●WHY]"]) });
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("creates, reads, updates with versions, and restores", async () => {
    const c = await call(tool, env.ctx, "POST", "documents", { title: "Customer onboarding", kind: "sop", body: "# A\n\n## Procedure\n1. one", status: "active", review_frequency: "quarterly" });
    expect(c.status).toBe(201);
    id = c.data.document.id;
    expect(c.data.document).toMatchObject({ version: 1, owner: env.ctx.userId });
    const u = await call(tool, env.ctx, "PUT", `documents/${id}`, { body: "# A\n\n## Procedure\n1. one\n2. two", note: "added step" });
    expect(u.data.document.version).toBe(2);
    expect((await call(tool, env.ctx, "PUT", `documents/${id}`, { status: "active" })).data.document.version).toBe(2);
    const g = await call(tool, env.ctx, "GET", `documents/${id}`);
    expect(g.data.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    const r = await call(tool, env.ctx, "POST", `documents/${id}/restore`, { version: 1 });
    expect(r.data.document).toMatchObject({ version: 3, body: "# A\n\n## Procedure\n1. one" });
    expect((await call(tool, env.ctx, "POST", `documents/${id}/restore`, { version: 99 })).status).toBe(404);
    const rev = await call(tool, env.ctx, "POST", `documents/${id}/reviewed`);
    expect(rev.data.document.lastReviewed).toMatch(/^\d{4}-\d\d-\d\d$/);
  });

  it("validates input", async () => {
    expect((await call(tool, env.ctx, "POST", "documents", { title: "", kind: "sop" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "documents", { title: "x", kind: "bogus" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "documents", { title: "x", owner: "someone-else" })).status).toBe(400);
    expect((await call(tool, env.ctx, "GET", "documents/not-a-uuid")).status).toBe(404);
    expect((await call(tool, env.ctx, "POST", "generate", { kind: "nope" })).status).toBe(400);
  });

  it("formats an SOP and generates documents server-side", async () => {
    const f = await call(tool, env.ctx, "POST", "sop/format", { name: "Close shop", steps: "Lock door" });
    expect(f.data.body).toContain("1. Lock door");
    const g = await call(tool, env.ctx, "POST", "generate", { kind: "quote", fields: { client: "Bob", items: "Part | 2 | 10" } });
    expect(g.data.body).toContain("Total: $20.00");
    expect(g.data.body).toContain("Test Co A");
  });

  it("isolates businesses", async () => {
    expect((await call(tool, env.other, "GET", "documents")).data.documents).toEqual([]);
    expect((await call(tool, env.other, "GET", `documents/${id}`)).status).toBe(404);
    expect((await call(tool, env.other, "PUT", `documents/${id}`, { title: "hack" })).status).toBe(404);
    expect((await call(tool, env.other, "DELETE", `documents/${id}`)).status).toBe(404);
    expect((await call(tool, env.other, "POST", `documents/${id}/restore`, { version: 1 })).status).toBe(404);
    expect(await tool.resolve!(env.other, id)).toBeNull();
    expect(await tool.search!(env.other, "onboarding", 5)).toEqual([]);
  });

  it("viewers can read but not change", async () => {
    const v = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await call(tool, v.ctx, "POST", "documents", { title: "x" })).status).toBe(403);
      expect((await call(tool, v.ctx, "POST", "ai", { action: "draft_sop", process: "x" })).status).toBe(403);
      expect((await call(tool, v.ctx, "GET", "documents")).status).toBe(200);
    } finally {
      await v.cleanup();
    }
  });

  it("runs an AI job asynchronously, cleans the result, and grounds the prompt", async () => {
    const s = await call(tool, env.ctx, "POST", "ai", { action: "draft_sop", process: "Handle a complaint", notes: "call within a day" });
    expect(s.status).toBe(202);
    const p = await call(tool, env.ctx, "GET", `ai/${s.data.jobId}`);
    expect(p.data).toMatchObject({ state: "done", text: "# Draft\n\n## Purpose\nBecause. [●WHY]", label: "AI draft, review before use" });
    const req = env.ai.calls[0];
    expect(req.prompt).toContain("Test Co A");
    expect(req.prompt).toContain("Handle a complaint");
    expect(req.system).toContain("[●PLACEHOLDER]");
    expect((await call(tool, env.ctx, "POST", "ai", { action: "improve" })).status).toBe(400);
  });

  it("reports AI as unavailable instead of failing silently", async () => {
    const off = new FakeAi();
    off.available = false;
    const e2 = await makeTestEnv([tool], { ai: off });
    try {
      expect((await call(tool, e2.ctx, "POST", "ai", { action: "draft_sop", process: "x" })).status).toBe(503);
    } finally {
      await e2.cleanup();
    }
  });

  it("publishes facts, description, attention, search and resolve", async () => {
    await call(tool, env.ctx, "POST", "documents", { title: "Daily data backup", kind: "checklist", body: "- [ ] run backup", status: "active" });
    const f = await tool.facts!(env.ctx);
    expect(f).toMatchObject({ sopCount: 1, byKind: { sop: 1, checklist: 1 }, hasCustomerOnboarding: true, hasBackupPlan: true, hasIncidentPlan: false });
    expect(typeof f.lastUpdated).toBe("string");
    const d = await tool.describe!(env.ctx);
    expect(d).toMatch(/2 documented items/);
    expect(d.length).toBeLessThanOrEqual(600);
    expect((await tool.search!(env.ctx, "run backup", 5))[0]).toMatchObject({ title: "Daily data backup", href: expect.stringContaining("/app/t/sops/") });
    expect(await tool.resolve!(env.ctx, id)).toMatchObject({ title: "Customer onboarding", href: `/app/t/sops/${id}` });
    expect(await tool.resolve!(env.ctx, "bad")).toBeNull();
    expect(await tool.attention!(env.ctx)).toEqual([]);
    await env.sql`UPDATE sops_documents SET created_at = now() - interval '2 years', last_reviewed = NULL WHERE id = ${id}`;
    const a = await tool.attention!(env.ctx);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ severity: "review", href: `/app/t/sops/${id}` });
    expect((await env.ctx.context()).summaries.sops).toMatch(/documented/);
  });

  it("links documents to other records", async () => {
    await env.ctx.links.add({ tool: "sops", id }, { tool: "sops", id }, "self");
    expect((await env.ctx.links.list({ tool: "sops", id }))[0]).toMatchObject({ tool: "sops", title: "Customer onboarding" });
  });
});
