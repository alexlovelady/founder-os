import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import type { BusinessProfile, Facts, ToolDef } from "@founderos/sdk";
import { buildItem, CATEGORIES, countsByCategory, evalCondition, evaluate, evaluateAll, notTracked, RULES, ruleApplies, sortItems, type Check, type Condition, type HealthRule } from "../src/engine";
import { tool } from "../src/index";

const profile = (over: Partial<BusinessProfile> = {}): BusinessProfile => ({
  id: "b", name: "Co", description: "", industry: "", entityType: "llc", country: "United States", state: "North Carolina", city: "", website: "",
  lifecycleStage: "operating", employeeCount: 2, operations: { hasEmployees: true, usesContractors: true, hasCustomers: true, hasWebsite: true, collectsPersonalData: true }, goals: [], ...over,
});

const rule = (check: Check): HealthRule => ({ id: "r", category: "Legal", title: "T", detail: "D", conditions: [], check, toolName: "Some tool", href: "/app/t/x", surfaceInAttention: true });

describe("check evaluation (table)", () => {
  const cases: [string, Check, Facts, string][] = [
    ["bool true", { kind: "bool", tool: "vault", key: "k" }, { vault: { k: true } }, "complete"],
    ["bool false", { kind: "bool", tool: "vault", key: "k" }, { vault: { k: false } }, "missing"],
    ["bool tool missing", { kind: "bool", tool: "vault", key: "k" }, {}, "unknown"],
    ["bool key missing", { kind: "bool", tool: "vault", key: "k" }, { vault: {} }, "unknown"],
    ["bool wrong type is unknown, not complete", { kind: "bool", tool: "vault", key: "k" }, { vault: { k: "yes" } }, "unknown"],
    ["zero ok", { kind: "zero", tool: "tasks", key: "overdue" }, { tasks: { overdue: 0 } }, "complete"],
    ["zero some", { kind: "zero", tool: "tasks", key: "overdue" }, { tasks: { overdue: 3 } }, "attention"],
    ["zero some as missing", { kind: "zero", tool: "c", key: "m", otherwise: "missing" }, { c: { m: 2 } }, "missing"],
    ["zero absent", { kind: "zero", tool: "tasks", key: "overdue" }, { tasks: {} }, "unknown"],
    ["zero NaN is unknown", { kind: "zero", tool: "tasks", key: "overdue" }, { tasks: { overdue: Number.NaN } }, "unknown"],
    ["positive some", { kind: "positive", tool: "sops", key: "n" }, { sops: { n: 2 } }, "complete"],
    ["positive none", { kind: "positive", tool: "sops", key: "n" }, { sops: { n: 0 } }, "missing"],
    ["positive absent", { kind: "positive", tool: "sops", key: "n" }, {}, "unknown"],
    ["runway healthy", { kind: "runway", minMonths: 3 }, { finance: { latestRunwayMonths: 8, calculatorsUsed: ["runway"] } }, "complete"],
    ["runway short", { kind: "runway", minMonths: 3 }, { finance: { latestRunwayMonths: 2, calculatorsUsed: ["runway"] } }, "attention"],
    ["runway not burning", { kind: "runway", minMonths: 3 }, { finance: { latestRunwayMonths: null, calculatorsUsed: ["runway"] } }, "complete"],
    ["runway never calculated", { kind: "runway", minMonths: 3 }, { finance: { latestRunwayMonths: null, calculatorsUsed: [] } }, "missing"],
    ["runway finance absent", { kind: "runway", minMonths: 3 }, {}, "unknown"],
  ];
  it.each(cases)("%s", (_n, check, facts, expected) => {
    expect(evaluate(rule(check), facts).status).toBe(expected);
  });
  it("unknown results name the tool to use", () => {
    expect(notTracked({ toolName: "CRM" }).reason).toMatch(/Not tracked yet.*CRM/);
  });
});

describe("profile conditions (table)", () => {
  const cases: [string, Condition, Partial<BusinessProfile>, string][] = [
    ["entity in", { type: "entity", in: ["llc"] }, { entityType: "llc" }, "yes"],
    ["entity out", { type: "entity", in: ["llc"] }, { entityType: "sole_proprietor" }, "no"],
    ["entity not formed", { type: "entity", in: ["llc"] }, { entityType: "not_formed" }, "unknown"],
    ["stage notIn", { type: "stage", notIn: ["idea"] }, { lifecycleStage: "idea" }, "no"],
    ["stage in", { type: "stage", in: ["operating", "growing"] }, { lifecycleStage: "growing" }, "yes"],
    ["flag true", { type: "flag", key: "usesContractors" }, { operations: { usesContractors: true } }, "yes"],
    ["flag false", { type: "flag", key: "usesContractors" }, { operations: { usesContractors: false } }, "no"],
    ["flag missing", { type: "flag", key: "usesContractors" }, { operations: {} }, "unknown"],
    ["employees null", { type: "employees", min: 1 }, { employeeCount: null }, "unknown"],
    ["anyOf", { type: "anyOf", of: [{ type: "flag", key: "x" }, { type: "employees", min: 1 }] }, { operations: {}, employeeCount: 5 }, "yes"],
  ];
  it.each(cases)("%s", (_n, c, over, expected) => {
    expect(evalCondition(c, profile(over))).toBe(expected);
  });
  it("hides rules that clearly do not apply but keeps ones with unknown profile data", () => {
    const contractors = RULES.find((r) => r.id === "legal-contractor-agreements")!;
    expect(ruleApplies(contractors, profile({ operations: { usesContractors: false } }))).toBe(false);
    expect(ruleApplies(contractors, profile({ operations: {} }))).toBe(true);
    const idea = evaluateAll(RULES, profile({ lifecycleStage: "idea" }), {}).map((i) => i.id);
    expect(idea).not.toContain("finance-runway");
    expect(evaluateAll(RULES, profile({ entityType: "sole_proprietor" }), {}).map((i) => i.id)).not.toContain("legal-formation-docs");
  });
});

describe("rule set", () => {
  it("has unique ids, valid categories, in-app links and no assertive legal wording", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) {
      expect(CATEGORIES).toContain(r.category);
      expect(r.href).toMatch(/^\/app\/t\/[a-z]+$/);
      expect(`${r.title} ${r.detail}`).not.toMatch(/\b(you must|is required by law|illegal)\b/i);
    }
    for (const c of CATEGORIES) expect(RULES.some((r) => r.category === c)).toBe(true);
  });
  it("legal-uncertain items use cautious wording", () => {
    for (const id of ["legal-operating-agreement", "legal-privacy-policy", "legal-contractor-agreements", "legal-insurance", "compliance-ein"]) {
      expect(RULES.find((r) => r.id === id)!.detail).toMatch(/^Review whether/);
    }
  });
});

describe("items, confirmations and counts", () => {
  const vaultRule = RULES.find((r) => r.id === "legal-privacy-policy")!;
  it("confirmations override facts; unknown is never complete", () => {
    expect(buildItem(vaultRule, {}).status).toBe("unknown");
    expect(buildItem(vaultRule, { vault: { hasPrivacyPolicy: false } }).status).toBe("missing");
    const done = buildItem(vaultRule, { vault: { hasPrivacyPolicy: false } }, { ruleId: vaultRule.id, status: "complete", note: "On the website", confirmedAt: "2026-01-01T00:00:00.000Z" });
    expect(done).toMatchObject({ status: "complete", derivedStatus: "missing", source: "confirmed", note: "On the website" });
    const na = buildItem(vaultRule, {}, { ruleId: vaultRule.id, status: "not_applicable", note: "", confirmedAt: "x" });
    expect(na.status).toBe("not_applicable");
  });
  it("counts per category with no numeric score", () => {
    const items = evaluateAll(RULES, profile(), { vault: { hasPrivacyPolicy: true, hasFormationDocs: false }, tasks: { overdue: 2 } });
    const counts = countsByCategory(items);
    expect(Object.keys(counts)).toEqual([...CATEGORIES]);
    expect(counts.Legal.complete).toBeGreaterThanOrEqual(1);
    expect(counts.Operations.attention).toBe(1);
    expect(counts.Legal.unknown + counts.Legal.complete + counts.Legal.missing + counts.Legal.attention + counts.Legal.not_applicable).toBe(items.filter((i) => i.category === "Legal").length);
    expect(JSON.stringify(counts)).not.toMatch(/score/i);
  });
  it("sorts attention before missing before unknown before complete", () => {
    const items = evaluateAll(RULES, profile(), { vault: { hasPrivacyPolicy: true, hasFormationDocs: false }, tasks: { overdue: 2 } });
    const order = sortItems(items).map((i) => i.status);
    const rank = { attention: 0, missing: 1, unknown: 2, complete: 3, not_applicable: 4 } as const;
    expect(order.map((s) => rank[s])).toEqual([...order.map((s) => rank[s])].sort((a, b) => a - b));
  });
});

const fakeVault: ToolDef = { id: "vault", name: "Document vault", description: "", group: "business", status: "live", facts: async () => ({ hasPrivacyPolicy: false, hasFormationDocs: true, documentCount: 3, expired: 0 }) };
const fakeTasks: ToolDef = { id: "tasks", name: "Tasks", description: "", group: "business", status: "live", facts: async () => ({ overdue: 2 }) };

describe("health tool (database), with other tools publishing real facts", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv([tool, fakeVault, fakeTasks]);
  });
  afterAll(async () => {
    await env.cleanup();
  });
  const items = async (ctx = env.ctx, q = "") => (await call(tool, ctx, "GET", `items${q}`)).data;
  const get = async (id: string, ctx = env.ctx) => (await items(ctx)).items.find((i: { id: string }) => i.id === id);

  it("is live and derives items from facts (missing tools are unknown, not complete)", async () => {
    expect(tool.status).toBe("live");
    const d = await items();
    expect(await get("legal-formation-docs")).toMatchObject({ status: "complete", source: "facts" });
    expect(await get("legal-privacy-policy")).toMatchObject({ status: "missing", href: "/app/t/vault" });
    expect(await get("ops-overdue-tasks")).toMatchObject({ status: "attention" });
    expect(await get("sales-contacts")).toMatchObject({ status: "unknown", reason: expect.stringContaining("Not tracked yet") });
    expect(await get("finance-runway")).toMatchObject({ status: "unknown" });
    expect(d.byCategory.Legal.complete).toBeGreaterThan(0);
    expect(d.totals.unknown).toBeGreaterThan(0);
  });

  it("filters by status and category and validates the filter", async () => {
    expect((await items(env.ctx, "?status=unknown")).items.every((i: { status: string }) => i.status === "unknown")).toBe(true);
    expect((await items(env.ctx, "?category=Legal")).items.every((i: { category: string }) => i.category === "Legal")).toBe(true);
    expect((await call(tool, env.ctx, "GET", "items?status=bogus")).status).toBe(400);
    expect((await call(tool, env.ctx, "GET", "items?category=bogus")).status).toBe(400);
  });

  it("confirms an item as done outside the system, then undoes it", async () => {
    const r = await call(tool, env.ctx, "PUT", "confirmations/legal-privacy-policy", { status: "complete", note: "Hosted on our site" });
    expect(r.status).toBe(200);
    expect(r.data.item).toMatchObject({ status: "complete", derivedStatus: "missing", source: "confirmed", note: "Hosted on our site" });
    const again = await call(tool, env.ctx, "PUT", "confirmations/legal-privacy-policy", { status: "not_applicable" });
    expect(again.data.item.status).toBe("not_applicable");
    const rows = await env.sql`SELECT count(*)::int AS n FROM health_confirmations WHERE business_id = ${env.ctx.businessId}`;
    expect(rows[0].n).toBe(1);
    expect((await call(tool, env.ctx, "DELETE", "confirmations/legal-privacy-policy")).status).toBe(200);
    expect(await get("legal-privacy-policy")).toMatchObject({ status: "missing", source: "facts" });
    expect((await call(tool, env.ctx, "DELETE", "confirmations/legal-privacy-policy")).status).toBe(404);
  });

  it("validates confirmations", async () => {
    expect((await call(tool, env.ctx, "PUT", "confirmations/legal-privacy-policy", { status: "attention" })).status).toBe(400);
    expect((await call(tool, env.ctx, "PUT", "confirmations/legal-privacy-policy", { status: "complete", extra: 1 })).status).toBe(400);
    expect((await call(tool, env.ctx, "PUT", "confirmations/legal-privacy-policy", { status: "complete", note: "x".repeat(1001) })).status).toBe(400);
    expect((await call(tool, env.ctx, "PUT", "confirmations/no-such-rule", { status: "complete" })).status).toBe(404);
    expect((await call(tool, env.ctx, "DELETE", "confirmations/no-such-rule")).status).toBe(404);
  });

  it("rejects confirming a rule that does not apply to this business", async () => {
    const orig = env.ctx.business.operations;
    env.ctx.business.operations = { ...orig, usesContractors: false };
    try {
      expect((await call(tool, env.ctx, "PUT", "confirmations/legal-contractor-agreements", { status: "complete" })).status).toBe(404);
      expect(await get("legal-contractor-agreements")).toBeUndefined();
    } finally {
      env.ctx.business.operations = orig;
    }
  });

  it("isolates businesses from each other", async () => {
    await call(tool, env.ctx, "PUT", "confirmations/legal-insurance", { status: "complete", note: "mine" });
    expect(await get("legal-insurance", env.other)).toMatchObject({ source: "facts" });
    expect((await call(tool, env.other, "DELETE", "confirmations/legal-insurance")).status).toBe(404);
    expect((await env.sql`SELECT count(*)::int AS n FROM health_confirmations WHERE business_id = ${env.other.businessId}`)[0].n).toBe(0);
    expect(await get("legal-insurance")).toMatchObject({ source: "confirmed", note: "mine" });
  });

  it("viewers can read but not confirm", async () => {
    const viewer = await makeTestEnv([tool, fakeVault], { role: "viewer" });
    try {
      expect((await call(tool, viewer.ctx, "GET", "items")).status).toBe(200);
      expect((await call(tool, viewer.ctx, "PUT", "confirmations/legal-insurance", { status: "complete" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "DELETE", "confirmations/legal-insurance")).status).toBe(403);
    } finally {
      await viewer.cleanup();
    }
  });

  it("publishes attention for what matters most, without duplicating other tools' own alerts", async () => {
    const a = await tool.attention!(env.ctx);
    expect(a.length).toBeLessThanOrEqual(10);
    expect(a.some((x) => x.id === "health-legal-privacy-policy" && x.title.startsWith("Missing"))).toBe(true);
    expect(a.every((x) => x.href?.startsWith("/app/t/"))).toBe(true);
    expect(a.some((x) => x.id === "health-ops-overdue-tasks")).toBe(false); // the tasks tool already raises overdue tasks
    expect(a.some((x) => x.id === "health-legal-formation-docs")).toBe(false); // complete
  });

  it("publishes facts with counts per category (no score), a short description, search and resolve", async () => {
    const f = await tool.facts!(env.ctx);
    expect(Object.keys(f.counts as object)).toEqual([...CATEGORIES]);
    expect(f).toMatchObject({ attentionCount: expect.any(Number), missingCount: expect.any(Number), notTrackedCount: expect.any(Number) });
    expect(JSON.stringify(f)).not.toMatch(/score/i);
    const d = await tool.describe!(env.ctx);
    expect(d.length).toBeLessThanOrEqual(600);
    expect(d).toMatch(/Business health checks/);
    expect((await env.ctx.search("privacy")).flatMap((g) => g.hits.map((h) => h.id))).toContain("legal-privacy-policy");
    expect(await tool.resolve!(env.ctx, "legal-privacy-policy")).toEqual({ title: "Privacy policy", href: "/app/t/health" });
    expect(await tool.resolve!(env.ctx, "nope")).toBeNull();
  });

  it("does not deadlock or recurse when assembling shared facts and context", async () => {
    const e = await makeTestEnv([tool, fakeVault, fakeTasks]);
    try {
      const facts = await e.ctx.facts();
      expect(facts.health).toMatchObject({ totals: expect.any(Object) });
      expect(facts.health.attentionCount).toBeGreaterThan(0); // real counts, not the empty re-entrant answer
      expect(facts.vault).toMatchObject({ documentCount: 3 });
      const e2 = await makeTestEnv([tool, fakeVault, fakeTasks]);
      try {
        const bc = await e2.ctx.context();
        expect(bc.summaries.health).toMatch(/Business health checks/);
        expect(bc.facts.health).toBeTruthy();
        expect(bc.attention.some((x) => x.id.startsWith("health-"))).toBe(true);
      } finally {
        await e2.cleanup();
      }
    } finally {
      await e.cleanup();
    }
  });

  it("treats every tool as unknown when nothing publishes facts", async () => {
    const bare = await makeTestEnv([tool]);
    try {
      const d = (await call(tool, bare.ctx, "GET", "items")).data;
      expect(d.items.every((i: { status: string }) => i.status === "unknown")).toBe(true);
      expect(d.totals.complete).toBe(0);
    } finally {
      await bare.cleanup();
    }
  });

  it("uses injected facts too", async () => {
    const injected = await makeTestEnv([tool], { facts: { sops: { sopCount: 4, hasIncidentPlan: true, hasBackupPlan: false }, crm: { contactCount: 0, staleCount: 3, openOpportunities: 0 } } });
    try {
      const d = (await call(tool, injected.ctx, "GET", "items")).data;
      const byId = Object.fromEntries(d.items.map((i: { id: string; status: string }) => [i.id, i.status]));
      expect(byId).toMatchObject({ "ops-sops": "complete", "security-incident-plan": "complete", "security-backup-plan": "missing", "sales-contacts": "missing", "sales-follow-ups": "attention" });
    } finally {
      await injected.cleanup();
    }
  });
});
