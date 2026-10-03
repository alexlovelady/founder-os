import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import type { BusinessProfile } from "@founderos/sdk";
import { addMonthsYmd, dueState, evalCondition, isValidDate, matchRule, nextDue, nextRuleDeadline, planSync, validateRules, type Condition, type Rule } from "../src/engine";
import { RULES, RULES_VERSION, rulesForBusiness } from "../src/seed";
import { findState, STATE_PORTALS } from "../src/states";
import { summarize } from "../src/summary";
import { tool } from "../src/index";

const profile = (over: Partial<BusinessProfile> = {}): BusinessProfile => ({
  id: "b", name: "Co", description: "", industry: "Home services", entityType: "llc", country: "United States", state: "North Carolina", city: "", website: "",
  lifecycleStage: "operating", employeeCount: 2, operations: { hasEmployees: true, usesContractors: false, hasCustomers: true, hasWebsite: true, collectsPersonalData: true, takesOnlinePayments: false, sellsAcrossStates: false },
  goals: [], ...over,
});
const code = (s: string) => findState(s)?.code ?? null;

describe("condition evaluation (table)", () => {
  const cases: [string, Condition, Partial<BusinessProfile>, "yes" | "no" | "unknown"][] = [
    ["country US yes", { type: "country", in: ["US"] }, { country: "United States" }, "yes"],
    ["country USA alias", { type: "country", in: ["US"] }, { country: "usa" }, "yes"],
    ["country other no", { type: "country", in: ["US"] }, { country: "Canada" }, "no"],
    ["country blank unknown", { type: "country", in: ["US"] }, { country: "" }, "unknown"],
    ["state match by name", { type: "state", is: "NC" }, { state: "North Carolina" }, "yes"],
    ["state match by code", { type: "state", is: "NC" }, { state: "nc" }, "yes"],
    ["state other", { type: "state", is: "NC" }, { state: "Texas" }, "no"],
    ["state blank is a strict no", { type: "state", is: "NC" }, { state: "" }, "no"],
    ["entity in", { type: "entity", in: ["llc"] }, { entityType: "llc" }, "yes"],
    ["entity not in", { type: "entity", in: ["llc"] }, { entityType: "sole_proprietor" }, "no"],
    ["entity not_sure unknown", { type: "entity", in: ["llc"] }, { entityType: "not_sure" }, "unknown"],
    ["entity not_formed unknown", { type: "entity", in: ["llc"] }, { entityType: "not_formed" }, "unknown"],
    ["stage notIn idea", { type: "stage", notIn: ["idea"] }, { lifecycleStage: "idea" }, "no"],
    ["stage in", { type: "stage", in: ["operating"] }, { lifecycleStage: "operating" }, "yes"],
    ["flag true", { type: "flag", key: "usesContractors" }, { operations: { usesContractors: true } }, "yes"],
    ["flag false", { type: "flag", key: "usesContractors" }, { operations: { usesContractors: false } }, "no"],
    ["flag missing unknown", { type: "flag", key: "usesContractors" }, { operations: {} }, "unknown"],
    ["employees min met", { type: "employees", min: 1 }, { employeeCount: 3 }, "yes"],
    ["employees none", { type: "employees", min: 1 }, { employeeCount: 0 }, "no"],
    ["employees null unknown", { type: "employees", min: 1 }, { employeeCount: null }, "unknown"],
    ["industry match", { type: "industry", any: ["home"] }, { industry: "Home services" }, "yes"],
    ["industry blank unknown", { type: "industry", any: ["home"] }, { industry: "" }, "unknown"],
    ["anyOf yes beats unknown", { type: "anyOf", of: [{ type: "flag", key: "x" }, { type: "employees", min: 1 }] }, { operations: {}, employeeCount: 2 }, "yes"],
    ["anyOf all no", { type: "anyOf", of: [{ type: "flag", key: "x" }, { type: "employees", min: 1 }] }, { operations: { x: false }, employeeCount: 0 }, "no"],
    ["anyOf mixed unknown", { type: "anyOf", of: [{ type: "flag", key: "x" }, { type: "employees", min: 1 }] }, { operations: { x: false }, employeeCount: null }, "unknown"],
  ];
  it.each(cases)("%s", (_n, cond, over, expected) => {
    expect(evalCondition(cond, profile(over), code)).toBe(expected);
  });
});

describe("matchRule and wording", () => {
  const base: Rule = {
    id: "t", version: 1, title: "Thing", description: "", category: "other", priority: "normal", recurrence: null,
    conditions: [{ type: "flag", key: "usesContractors" }], recommendation: "Do the thing.", cautious: "Review whether the thing applies.",
    source: { title: "S", url: "https://example.gov", lastVerified: "2026-10-03" },
  };
  it("certain, uncertain, and not applicable", () => {
    expect(matchRule(base, profile({ operations: { usesContractors: true } }))).toMatchObject({ certainty: "certain", recommendation: "Do the thing." });
    expect(matchRule(base, profile({ operations: {} }))).toMatchObject({ certainty: "uncertain", recommendation: "Review whether the thing applies." });
    expect(matchRule(base, profile({ operations: { usesContractors: false } }))).toBeNull();
  });
  it("alwaysCautious rules stay uncertain, and default wording is cautious", () => {
    const r = { ...base, alwaysCautious: true, recommendation: "Review whether X." };
    expect(matchRule(r, profile({ operations: { usesContractors: true } }))).toMatchObject({ certainty: "uncertain", recommendation: "Review whether X." });
    const d = { ...base, cautious: undefined };
    expect(matchRule(d, profile({ operations: {} }))!.recommendation).toMatch(/^Review whether this applies/);
  });
});

describe("dates and recurrence", () => {
  it("validates dates", () => {
    expect(isValidDate("2026-02-29")).toBe(false);
    expect(isValidDate("2028-02-29")).toBe(true);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("x")).toBe(false);
  });
  it("adds months clamping to month end", () => {
    expect(addMonthsYmd("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsYmd("2026-11-15", 3)).toBe("2027-02-15");
  });
  it.each([
    ["2026-03-01", "quarterly", "2026-03-15", "2026-06-01"],
    ["2026-03-01", "yearly", "2026-03-15", "2027-03-01"],
    ["2025-01-01", "monthly", "2026-03-15", "2026-04-01"],
    ["2020-01-01", "yearly", "2026-03-15", "2027-01-01"],
  ] as const)("nextDue(%s, %s) after %s", (due, rec, today, expected) => {
    expect(nextDue(due, rec, today)).toBe(expected);
  });
  it("fixed rule deadlines roll to next year", () => {
    expect(nextRuleDeadline({ deadline: { month: 1, day: 31 } }, "2026-02-01")).toBe("2027-01-31");
    expect(nextRuleDeadline({ deadline: { month: 1, day: 31 } }, "2026-01-31")).toBe("2026-01-31");
    expect(nextRuleDeadline({ deadline: null }, "2026-02-01")).toBeNull();
  });
  it.each([
    ["missing", "2026-01-01", "overdue"], ["attention", "2026-03-20", "soon"], ["missing", "2026-12-01", "later"],
    ["complete", "2026-01-01", "none"], ["not_applicable", "2026-01-01", "none"], ["missing", null, "none"], ["missing", "2026-03-15", "soon"],
  ] as const)("dueState %s %s", (st, due, expected) => {
    expect(dueState(st, due, "2026-03-15")).toBe(expected);
  });
});

describe("sync planning", () => {
  const matches = rulesForBusiness(profile());
  it("inserts everything on first run and nothing on the second", () => {
    const first = planSync(matches, []);
    expect(first.insert.length).toBe(matches.length);
    const existing = matches.map((m, i) => ({ id: `id${i}`, ruleId: m.rule.id, ruleVersion: m.rule.version, status: "missing" as const, userEdited: false, uncertain: m.certainty === "uncertain" }));
    expect(planSync(matches, existing)).toEqual({ insert: [], refresh: [], remove: [] });
  });
  it("does not resurrect not_applicable, refreshes on version bump, removes only untouched items", () => {
    const m = matches[0];
    const base = { ruleId: m.rule.id, ruleVersion: m.rule.version, userEdited: true, uncertain: m.certainty === "uncertain" };
    expect(planSync([m], [{ id: "a", status: "not_applicable", ...base }]).insert).toEqual([]);
    expect(planSync([m], [{ id: "a", status: "complete", ...base, ruleVersion: 0 }]).refresh.map((r) => r.id)).toEqual(["a"]);
    const gone = { id: "g", ruleId: "no-longer", ruleVersion: 1, status: "missing" as const, userEdited: false, uncertain: false };
    expect(planSync([], [gone]).remove).toEqual(["g"]);
    expect(planSync([], [{ ...gone, userEdited: true }]).remove).toEqual([]);
    expect(planSync([], [{ ...gone, status: "complete" }]).remove).toEqual([]);
    expect(planSync([], [{ ...gone, ruleId: null }]).remove).toEqual([]);
  });
});

describe("seed rules", () => {
  it("are internally consistent", () => {
    expect(validateRules(RULES)).toEqual([]);
    expect(RULES_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
  it("every rule names an https source and unverified sources have no verification date", () => {
    for (const r of RULES) {
      expect(r.source.url).toMatch(/^https:\/\//);
      expect(r.source.title.length).toBeGreaterThan(3);
    }
    for (const s of STATE_PORTALS.filter((p) => !p.verified)) {
      expect(RULES.find((r) => r.id === `state-${s.code.toLowerCase()}-registration`)!.source.lastVerified).toBeNull();
    }
  });
  it("covers all 50 states plus DC with two state items each, and never invents deadlines or fees", () => {
    expect(STATE_PORTALS).toHaveLength(51);
    expect(RULES.filter((r) => r.id.startsWith("state-"))).toHaveLength(102);
    for (const r of RULES) {
      expect(r.deadline ?? null).toBeNull();
      expect(`${r.description} ${r.recommendation}`).not.toMatch(/\$\d/);
    }
  });
  it("uses cautious wording wherever applicability is uncertain", () => {
    for (const r of RULES.filter((x) => x.alwaysCautious)) expect(r.recommendation).toMatch(/^Review/);
    for (const r of RULES.filter((x) => !x.alwaysCautious)) expect(r.cautious).toMatch(/^Review whether/);
  });
  it("matches rules to the business profile", () => {
    const ids = (p: BusinessProfile) => rulesForBusiness(p).map((m) => m.rule.id);
    const nc = ids(profile());
    expect(nc).toContain("state-nc-registration");
    expect(nc).not.toContain("state-tx-registration");
    expect(nc).toEqual(expect.arrayContaining(["fed-ein", "fed-employment-taxes", "fed-form-i9", "fed-form-w4", "fed-privacy"]));
    expect(nc).not.toContain("fed-1099-nec");
    const contractors = ids(profile({ operations: { usesContractors: true, hasEmployees: false }, employeeCount: 0 }));
    expect(contractors).toEqual(expect.arrayContaining(["fed-1099-nec", "fed-worker-classification"]));
    expect(contractors).not.toContain("fed-form-i9");
    expect(ids(profile({ state: "" }))).not.toContain("state-nc-registration");
    expect(ids(profile({ country: "Canada" }))).not.toContain("fed-ein");
    expect(ids(profile({ operations: { takesOnlinePayments: true } }))).toContain("fed-pci");
    expect(ids(profile({ operations: { hasWebsite: false, collectsPersonalData: false } }))).not.toContain("fed-privacy");
  });
  it("cautious when the profile is incomplete", () => {
    const m = rulesForBusiness(profile({ entityType: "not_sure", operations: {}, employeeCount: null })).find((x) => x.rule.id === "fed-ein")!;
    expect(m.certainty).toBe("uncertain");
    expect(m.recommendation).toMatch(/^Review whether/);
  });
});

describe("summarize", () => {
  it("counts and finds the next upcoming deadline", () => {
    const s = summarize([
      { status: "complete", dueState: "none", dueDate: null, category: "payroll" },
      { status: "missing", dueState: "overdue", dueDate: "2026-01-01", category: "licenses" },
      { status: "attention", dueState: "soon", dueDate: "2026-04-01", category: "sales tax" },
      { status: "missing", dueState: "later", dueDate: "2026-09-01", category: "payroll" },
      { status: "not_applicable", dueState: "none", dueDate: null, category: "insurance" },
    ]);
    expect(s).toMatchObject({ total: 5, complete: 1, attention: 1, missing: 2, notApplicable: 1, open: 3, overdue: 1, dueSoon: 1, nextDueDate: "2026-04-01", categoriesMissing: ["licenses", "payroll"] });
  });
});

describe("compliance tool (database)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv([tool]);
  });
  afterAll(async () => {
    await env.cleanup();
  });
  const plus = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const items = async (ctx = env.ctx, q = "") => (await call(tool, ctx, "GET", `items${q}`)).data;
  const find = async (ruleId: string) => (await items()).items.find((i: { ruleId: string }) => i.ruleId === ruleId);

  it("is live and empty until the checklist is generated", async () => {
    expect(tool.status).toBe("live");
    expect((await items()).items).toEqual([]);
    expect(await tool.describe!(env.ctx)).toBe("");
  });

  it("generates the checklist from rules, idempotently", async () => {
    const r = await call(tool, env.ctx, "POST", "sync");
    expect(r.status).toBe(200);
    expect(r.data.inserted).toBeGreaterThan(8);
    const n = r.data.items.length;
    const again = await call(tool, env.ctx, "POST", "sync");
    expect(again.data).toMatchObject({ inserted: 0, refreshed: 0, removed: 0 });
    expect(again.data.items).toHaveLength(n);
    const ein = await find("fed-ein");
    expect(ein).toMatchObject({ status: "missing", category: "entity filing", custom: false, sourceUrl: expect.stringContaining("irs.gov"), lastVerified: "2026-10-03" });
    expect(await find("state-nc-registration")).toMatchObject({ sourceUrl: expect.stringContaining("sosnc.gov") });
    expect(await find("state-tx-registration")).toBeUndefined();
  });

  it("lets the user set status, due date and notes; completion stamps and clears", async () => {
    const ein = await find("fed-ein");
    const r = await call(tool, env.ctx, "PATCH", `items/${ein.id}`, { status: "complete", notes: "Letter in vault", dueDate: plus(200) });
    expect(r.status).toBe(200);
    expect(r.data.item).toMatchObject({ status: "complete", notes: "Letter in vault", dueState: "none" });
    expect(r.data.item.completedAt).toBeTruthy();
    const back = await call(tool, env.ctx, "PATCH", `items/${ein.id}`, { status: "attention" });
    expect(back.data.item.completedAt).toBeNull();
  });

  it("validates input", async () => {
    const ein = await find("fed-ein");
    expect((await call(tool, env.ctx, "PATCH", `items/${ein.id}`, { status: "done" })).status).toBe(400);
    expect((await call(tool, env.ctx, "PATCH", `items/${ein.id}`, { dueDate: "2026-02-30" })).status).toBe(400);
    expect((await call(tool, env.ctx, "PATCH", `items/${ein.id}`, { bogus: 1 })).status).toBe(400);
    expect((await call(tool, env.ctx, "PATCH", `items/${ein.id}`, { title: "Renamed" })).status).toBe(400);
    expect((await call(tool, env.ctx, "PATCH", "items/not-a-uuid", { status: "complete" })).status).toBe(404);
    expect((await call(tool, env.ctx, "PATCH", "items/00000000-0000-0000-0000-000000000000", { status: "complete" })).status).toBe(404);
    expect((await call(tool, env.ctx, "POST", "items", { title: "" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "items", { title: "x", sourceUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", "items", { title: "x", category: "nope" })).status).toBe(400);
    expect((await call(tool, env.ctx, "GET", "items?status=bad")).status).toBe(400);
    expect((await call(tool, env.ctx, "DELETE", `items/${ein.id}`)).status).toBe(400);
  });

  it("supports custom items, filters, renewal and deletion", async () => {
    const c = await call(tool, env.ctx, "POST", "items", { title: "Local business license renewal", category: "licenses", dueDate: plus(-3), recurrence: "yearly", sourceUrl: "https://example.gov/x" });
    expect(c.status).toBe(201);
    expect(c.data.item).toMatchObject({ custom: true, dueState: "overdue", recurring: true, recurrence: "yearly" });
    expect((await items(env.ctx, "?category=licenses")).items.every((i: { category: string }) => i.category === "licenses")).toBe(true);
    expect((await items(env.ctx, "?status=complete")).items.every((i: { status: string }) => i.status === "complete")).toBe(true);
    const id = c.data.item.id;
    const done = await call(tool, env.ctx, "PATCH", `items/${id}`, { status: "complete", title: "Local license renewal" });
    expect(done.data.item).toMatchObject({ title: "Local license renewal", status: "complete" });
    const renewed = await call(tool, env.ctx, "POST", `items/${id}/renew`);
    expect(renewed.data.item).toMatchObject({ status: "missing", completedAt: null, dueState: "later" });
    expect(renewed.data.item.dueDate > plus(300)).toBe(true);
    const ein = await find("fed-ein");
    expect((await call(tool, env.ctx, "POST", `items/${ein.id}/renew`)).status).toBe(400);
    expect((await call(tool, env.ctx, "DELETE", `items/${id}`)).status).toBe(200);
    expect((await call(tool, env.ctx, "DELETE", `items/${id}`)).status).toBe(404);
  });

  it("records that the user verified the source", async () => {
    const i = await find("fed-income-tax-return");
    const r = await call(tool, env.ctx, "PATCH", `items/${i.id}`, { verifiedNow: true });
    expect(r.data.item.lastVerified).toBe(plus(0));
  });

  it("re-syncs when the profile changes without duplicating or resurrecting", async () => {
    const i = await find("fed-licenses-permits");
    await call(tool, env.ctx, "PATCH", `items/${i.id}`, { status: "not_applicable" });
    const before = (await items()).items.length;
    const nc = env.ctx.business.state;
    env.ctx.business.state = "Texas";
    try {
      const r = await call(tool, env.ctx, "POST", "sync");
      expect(await find("state-tx-registration")).toBeTruthy();
      expect(await find("state-nc-registration")).toBeUndefined(); // untouched NC items are removed
      expect(r.data.inserted).toBe(2);
      expect(await find("fed-licenses-permits")).toMatchObject({ status: "not_applicable" });
      expect((await call(tool, env.ctx, "POST", "sync")).data).toMatchObject({ inserted: 0, removed: 0 });
      expect((await items()).items.length).toBe(before);
    } finally {
      env.ctx.business.state = nc;
    }
    await call(tool, env.ctx, "POST", "sync");
    expect(await find("state-nc-registration")).toBeTruthy();
    expect(await find("fed-licenses-permits")).toMatchObject({ status: "not_applicable" });
  });

  it("keeps items the user touched when they stop applying", async () => {
    const reg = await find("state-nc-periodic-report");
    await call(tool, env.ctx, "PATCH", `items/${reg.id}`, { notes: "Filed in March" });
    const nc = env.ctx.business.state;
    env.ctx.business.state = "Ohio";
    try {
      await call(tool, env.ctx, "POST", "sync");
      expect(await find("state-nc-periodic-report")).toMatchObject({ notes: "Filed in March" });
    } finally {
      env.ctx.business.state = nc;
    }
    await call(tool, env.ctx, "POST", "sync");
  });

  it("exposes the matching rules for transparency", async () => {
    const r = await call(tool, env.ctx, "GET", "rules");
    expect(r.data.version).toBe(RULES_VERSION);
    expect(r.data.applicable.map((x: { id: string }) => x.id)).toContain("fed-ein");
  });

  it("isolates businesses from each other", async () => {
    expect((await items(env.other)).items).toEqual([]);
    const mine = (await items()).items[0];
    expect((await call(tool, env.other, "PATCH", `items/${mine.id}`, { status: "complete" })).status).toBe(404);
    expect((await call(tool, env.other, "POST", `items/${mine.id}/renew`)).status).toBe(404);
    expect((await call(tool, env.other, "DELETE", `items/${mine.id}`)).status).toBe(404);
    expect(await tool.resolve!(env.other, mine.id)).toBeNull();
    expect(await tool.search!(env.other, "EIN", 5)).toEqual([]);
    expect(await tool.facts!(env.other)).toMatchObject({ itemCount: 0, openItems: 0 });
    await call(tool, env.other, "POST", "sync");
    expect((await items(env.other)).items.length).toBeGreaterThan(5);
    expect((await items(env.other)).items.some((i: { id: string }) => i.id === mine.id)).toBe(false);
  });

  it("viewers can read but not change", async () => {
    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await call(tool, viewer.ctx, "GET", "items")).status).toBe(200);
      expect((await call(tool, viewer.ctx, "POST", "sync")).status).toBe(403);
      expect((await call(tool, viewer.ctx, "POST", "items", { title: "x" })).status).toBe(403);
      const mine = (await items()).items[0];
      expect((await call(tool, viewer.ctx, "PATCH", `items/${mine.id}`, { status: "complete" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "DELETE", `items/${mine.id}`)).status).toBe(403);
      expect((await call(tool, viewer.ctx, "POST", `items/${mine.id}/renew`)).status).toBe(403);
    } finally {
      await viewer.cleanup();
    }
  });

  it("publishes attention for overdue, due soon, attention and high-value missing items", async () => {
    const lic = await find("fed-licenses-permits");
    await call(tool, env.ctx, "PATCH", `items/${lic.id}`, { status: "missing", dueDate: plus(-5) });
    const soon = await find("fed-income-tax-return");
    await call(tool, env.ctx, "PATCH", `items/${soon.id}`, { dueDate: plus(10) });
    const a = await tool.attention!(env.ctx);
    expect(a.length).toBeLessThanOrEqual(10);
    expect(a[0]).toMatchObject({ severity: "high", title: expect.stringContaining("Overdue") });
    expect(a.find((x) => x.title.startsWith("Due soon"))).toMatchObject({ severity: "review", href: expect.stringContaining("/app/t/compliance/i/") });
    expect(a.some((x) => x.id.startsWith("compliance-missing-"))).toBe(true); // high-priority missing (e.g. employment taxes)
    const attn = await find("fed-pci");
    if (attn) await call(tool, env.ctx, "PATCH", `items/${attn.id}`, { status: "attention" });
  });

  it("publishes facts, a short description, search and resolve", async () => {
    const f = await tool.facts!(env.ctx);
    expect(f).toMatchObject({ itemCount: expect.any(Number), openItems: expect.any(Number), overdue: 1, dueSoon: 1 });
    expect(f.categoriesMissing).toEqual(expect.arrayContaining(["payroll"]));
    expect(f.nextDueDate).toBe(plus(10));
    const d = await tool.describe!(env.ctx);
    expect(d.length).toBeLessThanOrEqual(600);
    expect(d).toMatch(/Compliance checklist/);
    expect(d).toMatch(/1 overdue/);
    const hits = await tool.search!(env.ctx, "employer identification", 5);
    expect(hits[0]).toMatchObject({ title: expect.stringContaining("EIN"), href: expect.stringContaining("/app/t/compliance/i/") });
    expect(await tool.resolve!(env.ctx, hits[0].id)).toMatchObject({ href: hits[0].href });
    expect(await tool.resolve!(env.ctx, "nope")).toBeNull();
    const bc = await env.ctx.context();
    expect(bc.summaries.compliance).toMatch(/Compliance checklist/);
    expect(bc.facts.compliance).toMatchObject({ overdue: 1 });
    expect(bc.attention.some((x) => x.id.startsWith("compliance-"))).toBe(true);
  });

  it("links checklist items to other records via the shared links feature", async () => {
    const ein = await find("fed-ein");
    const other = await find("fed-income-tax-return");
    await env.ctx.links.add({ tool: "compliance", id: ein.id }, { tool: "compliance", id: other.id }, "related");
    const linked = await env.ctx.links.list({ tool: "compliance", id: ein.id });
    expect(linked[0]).toMatchObject({ tool: "compliance", id: other.id });
    await expect(env.other.links.add({ tool: "compliance", id: ein.id }, { tool: "compliance", id: other.id })).rejects.toThrow();
  });
});
