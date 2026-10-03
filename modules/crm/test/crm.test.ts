import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";
import { pastCloseOpportunities, staleLeadContacts, staleOpportunities } from "../src/data";
import { computeStageStats, isStale, parseContactsCsv, parseCsv, toCsv } from "../src/logic";

const DAY = 86_400_000;
const ago = (days: number, from = new Date()) => new Date(from.getTime() - days * DAY);

describe("crm pure logic", () => {
  it("isStale respects the threshold and ignores closed items", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    expect(isStale(ago(13, now), now, 14)).toBe(false);
    expect(isStale(ago(14, now), now, 14)).toBe(true);
    expect(isStale(ago(100, now), now, 14, false)).toBe(false);
    expect(isStale(ago(5, now), now, 3)).toBe(true);
  });

  it("parses quoted CSV with commas, quotes, CRLF and a BOM", () => {
    const rows = parseCsv('﻿name,notes\r\n"Doe, Jane","said ""hi"""\r\nBob,plain');
    expect(rows).toEqual([["name", "notes"], ["Doe, Jane", 'said "hi"'], ["Bob", "plain"]]);
  });

  it("validates CSV rows and reports each problem with its line", () => {
    const csv = [
      "Name,Company,Email,Phone,Type,Tags",
      "Ada,Analytical,ada@example.com,555-0100,customer,vip;referral",
      ",NoName,x@example.com,,lead,",
      "Bad Email,Co,not-an-email,,lead,",
      "Bad Type,Co,b@example.com,,wizard,",
      "Dup,Co,ADA@example.com,,lead,",
      "Fine,,,,,",
    ].join("\n");
    const r = parseContactsCsv(csv);
    expect(r.rows.map((x) => x.name)).toEqual(["Ada", "Fine"]);
    expect(r.rows[0]).toMatchObject({ type: "customer", tags: ["vip", "referral"] });
    expect(r.rows[1].type).toBe("lead");
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
    expect(r.errors[0].error).toMatch(/name is required/);
    expect(r.errors[1].error).toMatch(/email/);
    expect(r.errors[2].error).toMatch(/type must be/);
    expect(r.errors[3].error).toMatch(/duplicate email/);
    expect(parseContactsCsv("company,email\nA,a@b.co").fatal).toMatch(/name/);
    expect(parseContactsCsv("").fatal).toMatch(/empty/);
  });

  it("export neutralises formula injection but keeps phone numbers", () => {
    const out = toCsv(["a", "b", "c"], [["=SUM(A1)", "+1 (555) 010-0000", "@cmd"]]);
    expect(out).toContain("'=SUM(A1)");
    expect(out).toContain("+1 (555) 010-0000");
    expect(out).toContain("'@cmd");
  });

  it("computes time in stage and win rate from history with fixed dates", () => {
    const now = new Date("2026-10-30T00:00:00Z");
    const d = (n: number) => new Date(now.getTime() - n * DAY);
    const stats = computeStageStats(
      [
        { opportunityId: "a", fromStage: null, toStage: "lead", changedAt: d(20) },
        { opportunityId: "a", fromStage: "lead", toStage: "contacted", changedAt: d(10) },
        { opportunityId: "a", fromStage: "contacted", toStage: "won", changedAt: d(4) },
        { opportunityId: "b", fromStage: null, toStage: "lead", changedAt: d(6) },
        { opportunityId: "c", fromStage: null, toStage: "lead", changedAt: d(8) },
        { opportunityId: "c", fromStage: "lead", toStage: "lost", changedAt: d(2) },
      ],
      now,
    );
    const lead = stats.stages.find((s) => s.stage === "lead")!;
    expect(lead.reached).toBe(3);
    expect(lead.avgDaysInStage).toBe(7.3); // (10 + 6 + 6) / 3
    expect(stats.stages.find((s) => s.stage === "contacted")!.avgDaysInStage).toBe(6);
    expect(stats).toMatchObject({ won: 1, lost: 1, winRatePct: 50 });
  });
});

describe("crm tool (database)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv([tool]);
  });
  afterAll(async () => {
    await env.cleanup();
  });

  const post = (path: string, body: unknown, ctx = env.ctx) => call(tool, ctx, "POST", path, body);
  let ada: string;
  let bob: string;
  let deal: string;

  it("creates, reads, updates and lists contacts", async () => {
    const a = await post("contacts", { name: "Ada Lovelace", company: "Analytical Co", email: "Ada@Example.com", phone: "555-0100", type: "customer", tags: ["vip"], notes: "met at conference" });
    expect(a.status).toBe(201);
    ada = a.data.contact.id;
    const b = await post("contacts", { name: "Bob Builder", type: "lead" });
    bob = b.data.contact.id;
    expect(b.data.contact).toMatchObject({ company: "", status: "active", tags: [] });

    const list = await call(tool, env.ctx, "GET", "contacts");
    expect(list.data.contacts.map((c: { name: string }) => c.name)).toEqual(["Ada Lovelace", "Bob Builder"]);
    expect((await call(tool, env.ctx, "GET", "contacts?q=analytical")).data.contacts).toHaveLength(1);
    expect((await call(tool, env.ctx, "GET", "contacts?q=CONFERENCE")).data.contacts).toHaveLength(1);
    expect((await call(tool, env.ctx, "GET", "contacts?type=lead")).data.contacts.map((c: { name: string }) => c.name)).toEqual(["Bob Builder"]);
    expect((await call(tool, env.ctx, "GET", "contacts?tag=VIP")).data.contacts).toHaveLength(1);
    expect((await call(tool, env.ctx, "GET", "contacts?q=%25")).data.contacts).toHaveLength(0); // wildcard is escaped
    expect((await call(tool, env.ctx, "GET", "contacts?type=nope")).status).toBe(400);

    const patched = await call(tool, env.ctx, "PATCH", `contacts/${bob}`, { company: "Bob Co", status: "inactive" });
    expect(patched.data.contact).toMatchObject({ name: "Bob Builder", company: "Bob Co", status: "inactive" });
    expect((await call(tool, env.ctx, "GET", `contacts/${bob}`)).data.contact.company).toBe("Bob Co");
    await call(tool, env.ctx, "PATCH", `contacts/${bob}`, { status: "active" });
  });

  it("validates contact input", async () => {
    expect((await post("contacts", { name: "" })).status).toBe(400);
    expect((await post("contacts", { name: "X", email: "nope" })).status).toBe(400);
    expect((await post("contacts", { name: "X", type: "alien" })).status).toBe(400);
    expect((await post("contacts", { name: "X", tags: Array(30).fill("t") })).status).toBe(400);
    expect((await call(tool, env.ctx, "GET", "contacts/not-a-uuid")).status).toBe(404);
  });

  it("warns about duplicate emails (case-insensitive) and allows an explicit override", async () => {
    const dup = await post("contacts", { name: "Other Ada", email: "ADA@example.com" });
    expect(dup.status).toBe(409);
    expect(dup.data.duplicates).toEqual([{ id: ada, name: "Ada Lovelace" }]);
    const check = await call(tool, env.ctx, "GET", "duplicates?email=ada@EXAMPLE.com");
    expect(check.data.duplicates).toHaveLength(1);
    expect((await call(tool, env.ctx, "GET", `duplicates?email=ada@example.com&excludeId=${ada}`)).data.duplicates).toHaveLength(0);
    expect((await call(tool, env.ctx, "GET", "duplicates?email=")).data.duplicates).toHaveLength(0);
    // Same email in another business is not a duplicate.
    expect((await post("contacts", { name: "Ada elsewhere", email: "ada@example.com" }, env.other)).status).toBe(201);
    const forced = await post("contacts", { name: "Other Ada", email: "ada@example.com", allowDuplicate: true });
    expect(forced.status).toBe(201);
    expect(forced.data.duplicates).toHaveLength(1);
    // Changing an email to a used one is also flagged.
    const edit = await call(tool, env.ctx, "PATCH", `contacts/${bob}`, { email: "ada@example.com" });
    expect(edit.status).toBe(409);
    await call(tool, env.ctx, "DELETE", `contacts/${forced.data.contact.id}`);
  });

  it("creates opportunities with stage history and computes time in stage", async () => {
    expect((await post("opportunities", { contactId: ada, title: "" })).status).toBe(400);
    expect((await post("opportunities", { contactId: ada, title: "Big deal", valueCents: -1 })).status).toBe(400);
    expect((await post("opportunities", { contactId: ada, title: "Big deal", valueCents: 1.5 })).status).toBe(400);
    expect((await post("opportunities", { contactId: ada, title: "Big deal", expectedClose: "2026-13-45" })).status).toBe(400);
    const r = await post("opportunities", { contactId: ada, title: "Big deal", valueCents: 500_000, expectedClose: "2099-01-01", owner: "me" });
    expect(r.status).toBe(201);
    deal = r.data.opportunity.id;
    expect(r.data.opportunity).toMatchObject({ stage: "lead", valueCents: 500_000, contactName: "Ada Lovelace" });

    expect((await post(`opportunities/${deal}/stage`, { stage: "bogus" })).status).toBe(400);
    expect((await post(`opportunities/${deal}/stage`, { stage: "lost" })).status).toBe(400); // reason required
    const moved = await post(`opportunities/${deal}/stage`, { stage: "qualified" });
    expect(moved.data.opportunity.stage).toBe("qualified");
    await post(`opportunities/${deal}/stage`, { stage: "qualified" }); // no-op, no extra history

    const hist = await env.sql<{ from_stage: string | null; to_stage: string }[]>`SELECT from_stage, to_stage FROM crm_stage_history WHERE opportunity_id = ${deal} ORDER BY changed_at, to_stage`;
    expect(hist.map((h) => [h.from_stage, h.to_stage])).toEqual([[null, "lead"], ["lead", "qualified"]]);

    // Backdate the history so time in stage is deterministic.
    await env.sql`UPDATE crm_stage_history SET changed_at = CASE to_stage WHEN 'lead' THEN now() - interval '10 days' ELSE now() - interval '4 days' END WHERE opportunity_id = ${deal}`;
    const pipe = (await call(tool, env.ctx, "GET", "pipeline")).data;
    const lead = pipe.stats.stages.find((s: { stage: string }) => s.stage === "lead");
    expect(lead.avgDaysInStage).toBe(6);
    expect(pipe.stats.stages.find((s: { stage: string }) => s.stage === "qualified").avgDaysInStage).toBe(4);
  });

  it("closing as won or lost records a timestamp and the lost reason; pipeline columns total up", async () => {
    const small = (await post("opportunities", { contactId: bob, title: "Small deal", valueCents: 20_000, stage: "negotiation" })).data.opportunity.id;
    const lost = (await post("opportunities", { contactId: bob, title: "Lost deal", valueCents: 10_000 })).data.opportunity.id;
    const lr = await post(`opportunities/${lost}/stage`, { stage: "lost", lostReason: "Went with a competitor" });
    expect(lr.data.opportunity).toMatchObject({ stage: "lost", lostReason: "Went with a competitor" });
    expect(lr.data.opportunity.closedAt).toBeTruthy();
    const reopened = await post(`opportunities/${lost}/stage`, { stage: "contacted" });
    expect(reopened.data.opportunity).toMatchObject({ lostReason: "", closedAt: null });
    await post(`opportunities/${lost}/stage`, { stage: "won" });
    await call(tool, env.ctx, "DELETE", `opportunities/${lost}`);

    const pipe = (await call(tool, env.ctx, "GET", "pipeline")).data;
    const col = (s: string) => pipe.columns.find((c: { stage: string }) => c.stage === s);
    expect(col("qualified")).toMatchObject({ count: 1, totalCents: 500_000 });
    expect(col("negotiation")).toMatchObject({ count: 1, totalCents: 20_000 });
    expect(col("won")).toMatchObject({ count: 0, totalCents: 0 });
    expect(small).toBeTruthy();
  });

  it("adds notes and builds a timeline of notes and stage changes", async () => {
    expect((await post(`contacts/${ada}/notes`, { body: "  " })).status).toBe(400);
    const n = await post(`contacts/${ada}/notes`, { body: "Called, wants a quote" });
    expect(n.status).toBe(201);
    await post(`opportunities/${deal}/notes`, { body: "Sent pricing" });
    const detail = (await call(tool, env.ctx, "GET", `contacts/${ada}`)).data;
    const kinds = detail.timeline.map((t: { kind: string; body?: string }) => (t.kind === "note" ? t.body : "stage"));
    expect(kinds).toEqual(expect.arrayContaining(["Called, wants a quote", "Sent pricing", "stage"]));
    expect(detail.opportunities).toHaveLength(1);
    const oppDetail = (await call(tool, env.ctx, "GET", `opportunities/${deal}`)).data;
    expect(oppDetail.timeline.some((t: { body?: string }) => t.body === "Called, wants a quote")).toBe(false); // contact-level note not on the deal
    expect(oppDetail.timeline.some((t: { body?: string }) => t.body === "Sent pricing")).toBe(true);
  });

  it("isolates businesses: no cross-business reads, writes, links to records or opportunities", async () => {
    const o = env.other;
    expect((await call(tool, o, "GET", "contacts")).data.contacts.map((c: { name: string }) => c.name)).toEqual(["Ada elsewhere"]);
    expect((await call(tool, o, "GET", `contacts/${ada}`)).status).toBe(404);
    expect((await call(tool, o, "PATCH", `contacts/${ada}`, { name: "hacked" })).status).toBe(404);
    expect((await call(tool, o, "DELETE", `contacts/${ada}`)).status).toBe(404);
    expect((await post(`contacts/${ada}/notes`, { body: "x" }, o)).status).toBe(404);
    expect((await post("opportunities", { contactId: ada, title: "Sneaky" }, o)).status).toBe(404);
    expect((await call(tool, o, "GET", `opportunities/${deal}`)).status).toBe(404);
    expect((await call(tool, o, "PATCH", `opportunities/${deal}`, { title: "hacked" })).status).toBe(404);
    expect((await post(`opportunities/${deal}/stage`, { stage: "won" }, o)).status).toBe(404);
    expect((await post(`opportunities/${deal}/notes`, { body: "x" }, o)).status).toBe(404);
    expect((await call(tool, o, "DELETE", `opportunities/${deal}`)).status).toBe(404);
    expect((await call(tool, o, "GET", "opportunities")).data.opportunities).toEqual([]);
    expect((await call(tool, o, "GET", "duplicates?email=ada@example.com")).data.duplicates).toHaveLength(1); // only its own
    expect((await call(tool, o, "GET", "pipeline")).data.columns.every((c: { count: number }) => c.count === 0)).toBe(true);
    expect(await tool.resolve!(o, ada)).toBeNull();
    expect(await tool.resolve!(o, deal)).toBeNull();
    expect(await tool.search!(o, "Lovelace", 5)).toEqual([]);
    expect(await tool.facts!(o)).toMatchObject({ contactCount: 1, openOpportunities: 0 });
    // Links cannot point at another business's records.
    await expect(o.links.add({ tool: "crm", id: ada }, { tool: "crm", id: ada })).rejects.toThrow();
    // My data is untouched.
    expect((await call(tool, env.ctx, "GET", `contacts/${ada}`)).data.contact.name).toBe("Ada Lovelace");
  });

  it("viewers can read and export but not change anything", async () => {
    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      for (const [m, p, b] of [
        ["POST", "contacts", { name: "x" }],
        ["POST", "contacts/import", { csv: "name\nx" }],
        ["POST", "opportunities", { contactId: ada, title: "x" }],
      ] as const) expect((await call(tool, viewer.ctx, m, p, b)).status).toBe(403);
      expect((await call(tool, viewer.ctx, "PATCH", `contacts/${ada}`, { name: "x" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "DELETE", `contacts/${ada}`)).status).toBe(403);
      expect((await call(tool, viewer.ctx, "POST", `opportunities/${deal}/stage`, { stage: "won" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "POST", `contacts/${ada}/notes`, { body: "x" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "GET", "contacts")).status).toBe(200);
      expect((await call(tool, viewer.ctx, "GET", "pipeline")).status).toBe(200);
    } finally {
      await viewer.cleanup();
    }
  });

  it("imports CSV with a per-row error report, skips existing emails, and exports", async () => {
    const csv = [
      "name,company,email,phone,type,tags",
      "Cy Import,CyCo,cy@example.com,555-0111,partner,a;b",
      ",Nameless,n@example.com,,lead,",
      "Ada Again,AdaCo,ada@example.com,,lead,",
      "Zed,,zed@example.com,,wrong,",
      "Dee,,,,,",
    ].join("\n");
    const r = await post("contacts/import", { csv });
    expect(r.status).toBe(200);
    expect(r.data.created).toBe(2);
    expect(r.data.errors.map((e: { line: number }) => e.line)).toEqual([3, 4, 5]);
    expect(r.data.errors[1].error).toMatch(/already exists/);
    expect((await post("contacts/import", { csv: "" })).status).toBe(400);
    expect((await post("contacts/import", { csv: "company\nx" })).status).toBe(400);
    expect((await post("contacts/import", { csv: 42 })).status).toBe(400);

    const again = await post("contacts/import", { csv: "name,email\nCy Import,cy@example.com" });
    expect(again.data.created).toBe(0);
    const forced = await post("contacts/import", { csv: "name,email\nCy Two,cy@example.com", allowDuplicates: true });
    expect(forced.data.created).toBe(1);

    const res = await tool.api!(env.ctx, new Request("http://test/api/tools/crm/contacts/export"), ["contacts", "export"]);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe("name,company,email,phone,type,tags,status,source,created");
    expect(text).toContain("Ada Lovelace,Analytical Co,Ada@Example.com,555-0100,customer,vip");
    expect(text).toContain("Cy Import");
    expect(text).not.toContain("Ada elsewhere"); // other business
    // Round trip: the export is a valid import file.
    expect(parseContactsCsv(text).fatal).toBeUndefined();
  });

  it("stale logic: opportunities and leads with no recent activity, with controllable dates", async () => {
    const now = new Date();
    // Nothing is stale right now (all activity is fresh).
    expect(await staleOpportunities(env.ctx, now, 14)).toEqual([]);
    // Same data seen from 15 days in the future: open deals are stale.
    const future = new Date(now.getTime() + 15 * DAY);
    const stale = await staleOpportunities(env.ctx, future, 14);
    expect(stale.map((o) => o.title).sort()).toEqual(["Big deal", "Small deal"]);
    expect(await staleOpportunities(env.ctx, future, 30)).toEqual([]);
    expect((await staleLeadContacts(env.ctx, future, 14)).map((c) => c.name)).toEqual(expect.arrayContaining(["Dee"]));
    // Closed deals are never stale.
    const wonId = (await post("opportunities", { contactId: bob, title: "Done", stage: "won" })).data.opportunity.id;
    await env.sql`UPDATE crm_opportunities SET last_activity_at = now() - interval '60 days' WHERE id = ${wonId}`;
    expect((await staleOpportunities(env.ctx, now, 14)).map((o) => o.title)).not.toContain("Done");

    // Backdate a real deal and see it through the API and the published facts.
    await env.sql`UPDATE crm_opportunities SET last_activity_at = now() - interval '20 days' WHERE id = ${deal}`;
    const api = (await call(tool, env.ctx, "GET", "stale")).data;
    expect(api.opportunities.map((o: { title: string }) => o.title)).toEqual(["Big deal"]);
    expect((await call(tool, env.ctx, "GET", "stale?staleDays=30")).data.opportunities).toEqual([]);
    // Activity (a note) restarts the clock.
    await post(`opportunities/${deal}/notes`, { body: "Checked in" });
    expect((await call(tool, env.ctx, "GET", "stale")).data.opportunities).toEqual([]);
    await env.sql`DELETE FROM crm_opportunities WHERE id = ${wonId}`;
  });

  it("attention: stale deals and passed expected close dates", async () => {
    expect(await tool.attention!(env.ctx)).toEqual([]);
    const late = (await post("opportunities", { contactId: ada, title: "Late close", valueCents: 100_000, expectedClose: "2020-01-01" })).data.opportunity.id;
    const quiet = (await post("opportunities", { contactId: ada, title: "Gone quiet", valueCents: 5_000 })).data.opportunity.id;
    await env.sql`UPDATE crm_opportunities SET last_activity_at = now() - interval '30 days' WHERE id IN (${late}, ${quiet})`;
    const items = await tool.attention!(env.ctx);
    expect(items.map((i) => i.id).sort()).toEqual([`crm-pastclose-${late}`, `crm-stale-${quiet}`].sort());
    const past = items.find((i) => i.id.startsWith("crm-pastclose"))!;
    expect(past).toMatchObject({ severity: "review", dueDate: "2020-01-01", href: `/app/t/crm/opportunities/${late}` });
    expect((await pastCloseOpportunities(env.ctx)).map((o) => o.id)).toEqual([late]);
    // Never leaks email or phone into attention text.
    expect(JSON.stringify(items)).not.toMatch(/example\.com|555-/);
    // The dashboard context includes them.
    expect((await env.ctx.context()).attention.some((i) => i.id === `crm-stale-${quiet}`)).toBe(true);
    // More than 10 collapses into a roll-up.
    for (let i = 0; i < 11; i++) {
      const id = (await post("opportunities", { contactId: ada, title: `Quiet ${i}` })).data.opportunity.id;
      await env.sql`UPDATE crm_opportunities SET last_activity_at = now() - interval '40 days' WHERE id = ${id}`;
    }
    const many = await tool.attention!(env.ctx);
    expect(many).toHaveLength(10);
    expect(many[9].id).toBe("crm-more");
    await env.sql`DELETE FROM crm_opportunities WHERE business_id = ${env.ctx.businessId} AND (title LIKE 'Quiet %' OR id IN (${late}, ${quiet}))`;
  });

  it("publishes facts and a description", async () => {
    // Make one deal won recently and one won long ago.
    const won = (await post("opportunities", { contactId: ada, title: "Won recently", valueCents: 70_000 })).data.opportunity.id;
    await post(`opportunities/${won}/stage`, { stage: "won" });
    const old = (await post("opportunities", { contactId: ada, title: "Won long ago", valueCents: 90_000 })).data.opportunity.id;
    await post(`opportunities/${old}/stage`, { stage: "won" });
    await env.sql`UPDATE crm_opportunities SET closed_at = now() - interval '120 days' WHERE id = ${old}`;

    const f = await tool.facts!(env.ctx);
    expect(f).toMatchObject({
      customerCount: 1,
      openOpportunities: 2, // Big deal (500000) + Small deal (20000)
      pipelineValueCents: 520_000,
      wonLast90DaysCents: 70_000,
      hasFollowUpProcess: false,
    });
    expect(typeof f.contactCount).toBe("number");
    expect(typeof f.staleCount).toBe("number");
    expect((await env.ctx.facts()).crm).toHaveProperty("hasFollowUpProcess", false); // per-request cache, so counts may predate this test

    const text = await tool.describe!(env.ctx);
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toMatch(/\$5,200/);
    expect(text).toMatch(/open opportunities/);
    
    expect(text).not.toMatch(/example\.com/);
  });

  it("describe is empty for a business with no contacts", async () => {
    const empty = await makeTestEnv([tool]);
    try {
      expect(await tool.describe!(empty.ctx)).toBe("");
      expect(await tool.facts!(empty.ctx)).toMatchObject({ contactCount: 0, customerCount: 0, openOpportunities: 0, pipelineValueCents: 0, wonLast90DaysCents: 0, staleCount: 0, hasFollowUpProcess: false });
      expect(await tool.attention!(empty.ctx)).toEqual([]);
    } finally {
      await empty.cleanup();
    }
  });

  it("search and resolve cover contacts and opportunities", async () => {
    const byName = await tool.search!(env.ctx, "lovelace", 10);
    expect(byName[0]).toMatchObject({ id: ada, title: "Ada Lovelace", href: `/app/t/crm/contacts/${ada}` });
    expect((await tool.search!(env.ctx, "analytical", 10)).map((h) => h.id)).toContain(ada);
    expect((await tool.search!(env.ctx, "ada@example", 10)).map((h) => h.id)).toContain(ada);
    expect((await tool.search!(env.ctx, "conference", 10)).map((h) => h.id)).toContain(ada);
    const opp = await tool.search!(env.ctx, "big deal", 10);
    expect(opp[0]).toMatchObject({ id: deal, href: `/app/t/crm/opportunities/${deal}` });
    expect(await tool.search!(env.ctx, "zzzz-nothing", 10)).toEqual([]);
    expect((await tool.search!(env.ctx, "a", 1)).length).toBeLessThanOrEqual(1);
    expect((await env.ctx.search("lovelace")).flatMap((g) => g.hits.map((h) => h.id))).toContain(ada);

    expect(await tool.resolve!(env.ctx, ada)).toEqual({ title: "Ada Lovelace (Analytical Co)", href: `/app/t/crm/contacts/${ada}` });
    expect(await tool.resolve!(env.ctx, deal)).toEqual({ title: "Big deal (Ada Lovelace)", href: `/app/t/crm/opportunities/${deal}` });
    expect(await tool.resolve!(env.ctx, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await tool.resolve!(env.ctx, "garbage")).toBeNull();
  });

  it("links a contact to other records through the shared link table", async () => {
    await env.ctx.links.add({ tool: "crm", id: ada }, { tool: "crm", id: deal }, "deal");
    const linked = await env.ctx.links.list({ tool: "crm", id: ada });
    expect(linked[0]).toMatchObject({ tool: "crm", id: deal, title: "Big deal (Ada Lovelace)" });
  });

  it("deleting a contact removes its opportunities, notes and history", async () => {
    const tmp = (await post("contacts", { name: "Temp" })).data.contact.id;
    const o = (await post("opportunities", { contactId: tmp, title: "Temp deal" })).data.opportunity.id;
    await post(`contacts/${tmp}/notes`, { body: "n" });
    expect((await call(tool, env.ctx, "DELETE", `contacts/${tmp}`)).status).toBe(200);
    const [{ n }] = await env.sql<{ n: string }[]>`SELECT (SELECT count(*) FROM crm_opportunities WHERE contact_id = ${tmp}) + (SELECT count(*) FROM crm_stage_history WHERE opportunity_id = ${o}) + (SELECT count(*) FROM crm_notes WHERE contact_id = ${tmp}) AS n`;
    expect(Number(n)).toBe(0);
    expect((await call(tool, env.ctx, "DELETE", `contacts/${tmp}`)).status).toBe(404);
  });
});
