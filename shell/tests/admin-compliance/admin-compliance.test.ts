import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "@founderos/compliance";
import type { NetDeps, RawResponse } from "@founderos/compliance/src/source-check";
import type { Session } from "@/lib/auth/server";
import { recordAudit } from "@/lib/platform/audit";
import { guard, isRuleAction, opAction, opCreate, opGet, opList, opPreview, opUpdate, type Deps } from "@/app/api/admin/compliance/_lib";

const session = (role: string, id = "admin-user-1"): Session => ({ user: { id, email: `${id}@x.test`, displayName: id, role }, cookie: "", csrf: "" });
const ADMIN = session("admin");
const MEMBER = session("member", "plain-user");

const req = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/admin/compliance", { method, headers: { "content-type": "application/json", host: "localhost", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

const today = new Date().toISOString().slice(0, 10);
const rule = (over: Record<string, unknown> = {}) => ({
  title: "Admin test rule", description: "d", category: "other", conditions: [{ type: "country", in: ["US"] }], recommendation: "Review whether this applies.", alwaysCautious: true,
  sourceTitle: "Example", sourceUrl: "https://www.example.gov/page", jurisdiction: "US", lastVerified: today, ...over,
});

describe("guard (pure)", () => {
  it("only a platform admin passes; everyone else gets the standard 404", async () => {
    expect(guard(null, req("GET"), false)).toMatchObject({ response: expect.any(Response) });
    for (const s of [null, MEMBER, session("")]) {
      const g = guard(s, req("GET"), false);
      expect("response" in g && g.response.status).toBe(404);
    }
    expect(guard(ADMIN, req("GET"), false)).toEqual({ userId: "admin-user-1" });
  });
  it("writes also need a same-origin request", () => {
    const bad = guard(ADMIN, req("POST", {}, { origin: "https://evil.example" }), true);
    expect("response" in bad && bad.response.status).toBe(403);
    expect(guard(ADMIN, req("POST", {}, { origin: "http://localhost" }), true)).toEqual({ userId: "admin-user-1" });
    expect(guard(ADMIN, req("POST", {}), true)).toEqual({ userId: "admin-user-1" });
    // a cross-site GET is not blocked (reads change nothing)
    expect(guard(ADMIN, req("GET", undefined, { origin: "https://evil.example" }), false)).toEqual({ userId: "admin-user-1" });
  });
  it("knows the rule actions", () => {
    for (const a of ["publish", "disable", "restore", "verify", "check"]) expect(isRuleAction(a)).toBe(true);
    for (const a of ["delete", "", "PUBLISH", "../x"]) expect(isRuleAction(a)).toBe(false);
  });
});

describe("admin compliance API", () => {
  let env: TestEnv;
  const made: string[] = [];
  const res = (status: number, headers: Record<string, string> = {}): RawResponse => ({ status, headers, destroy() {} });
  const requested: string[] = [];
  const net: NetDeps = {
    resolve: async (h) => (h === "internal.example.org" ? ["10.0.0.9"] : ["93.184.216.34"]),
    async request({ url }) {
      requested.push(url.toString());
      return url.pathname === "/moved" ? res(301, { location: "https://www.example.gov/final" }) : res(200);
    },
  };
  let deps: Deps;
  const auditRows = async (slug: string) =>
    env.sql<{ action: string; user_id: string; business_id: string | null; meta: Record<string, unknown> }[]>`
      SELECT action, user_id, business_id, meta FROM audit_events WHERE resource_tool = 'compliance' AND resource_id = ${`admin:${slug}`} ORDER BY id`;
  const json = async (r: Response) => ({ status: r.status, data: await r.json() });
  const slug = () => { const s = `api-${Math.random().toString(36).slice(2, 8)}`; made.push(s); return s; };

  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    deps = { sql: env.sql, audit: recordAudit, net };
  });
  afterAll(async () => {
    if (made.length) await env.sql`DELETE FROM compliance_admin_rules WHERE id = ANY(${made})`;
    await env.sql`DELETE FROM audit_events WHERE resource_tool = 'compliance' AND resource_id LIKE 'admin:api-%'`;
    await env.cleanup();
  });

  it("non-admins and anonymous callers cannot read or change anything, and nothing is written or audited", async () => {
    const s = slug();
    for (const who of [null, MEMBER]) {
      expect((await opList(who, req("GET"), deps)).status).toBe(404);
      expect((await opCreate(who, req("POST", { slug: s, ...rule() }), deps)).status).toBe(404);
      expect((await opGet(who, req("GET"), deps, s)).status).toBe(404);
      expect((await opUpdate(who, req("PATCH", rule()), deps, s)).status).toBe(404);
      expect((await opPreview(who, req("POST", rule()))).status).toBe(404);
      for (const a of ["publish", "disable", "restore", "verify", "check"]) expect((await opAction(who, req("POST", {}), deps, s, a)).status).toBe(404);
    }
    const [row] = await env.sql`SELECT 1 FROM compliance_admin_rules WHERE id = ${s}`;
    expect(row).toBeUndefined();
    expect(await auditRows(s)).toEqual([]);
  });

  it("blocks cross-site writes even for an admin", async () => {
    const s = slug();
    const r = await opCreate(ADMIN, req("POST", { slug: s, ...rule() }, { origin: "https://evil.example" }), deps);
    expect(r.status).toBe(403);
    expect((await env.sql`SELECT 1 FROM compliance_admin_rules WHERE id = ${s}`).length).toBe(0);
  });

  it("create, edit, publish, check source, restore, verify and disable: each change is audited as the admin, platform-level", async () => {
    const s = slug();
    const created = await json(await opCreate(ADMIN, req("POST", { slug: s, ...rule() }), deps));
    expect(created).toMatchObject({ status: 201, data: { rule: { slug: s, status: "draft", version: 1 } } });

    const edited = await json(await opUpdate(ADMIN, req("PATCH", rule({ recommendation: "Review whether this applies to you." })), deps, s));
    expect(edited).toMatchObject({ status: 200, data: { changed: true } });
    const same = await json(await opUpdate(ADMIN, req("PATCH", rule({ recommendation: "Review whether this applies to you." })), deps, s));
    expect(same.data.changed).toBe(false);

    const pub = await json(await opAction(ADMIN, req("POST", {}), deps, s, "publish"));
    expect(pub).toMatchObject({ status: 200, data: { rule: { status: "published", enabled: true } } });

    const chk = await json(await opAction(ADMIN, req("POST", {}), deps, s, "check"));
    expect(chk).toMatchObject({ status: 200, data: { result: { ok: true, status: 200, finalUrl: "https://www.example.gov/page" }, rule: { lastCheck: { status: 200 } } } });
    expect(requested).toContain("https://www.example.gov/page");

    await opUpdate(ADMIN, req("PATCH", rule({ recommendation: "Review whether this applies, second wording." })), deps, s);
    const restored = await json(await opAction(ADMIN, req("POST", { version: 1 }), deps, s, "restore"));
    expect(restored).toMatchObject({ status: 200, data: { rule: { version: 3 } } });
    expect((await json(await opAction(ADMIN, req("POST", {}), deps, s, "restore"))).status).toBe(400); // no version given

    const ver = await json(await opAction(ADMIN, req("POST", {}), deps, s, "verify"));
    expect(ver.status).toBe(200);
    const off = await json(await opAction(ADMIN, req("POST", {}), deps, s, "disable"));
    expect(off).toMatchObject({ status: 200, data: { rule: { status: "disabled", enabled: false } } });

    const actions = (await auditRows(s)).map((a) => a.action);
    expect(actions).toEqual([
      "admin.compliance.rule.create", "admin.compliance.rule.update", "admin.compliance.rule.publish", "admin.compliance.rule.source_check",
      "admin.compliance.rule.update", "admin.compliance.rule.restore", "admin.compliance.rule.verify", "admin.compliance.rule.disable",
    ]);
    const rows = await auditRows(s);
    expect(rows.every((a) => a.user_id === "admin-user-1" && a.business_id === null)).toBe(true);
    expect(rows[0].meta).toMatchObject({ slug: s, version: 1, status: "draft" });
  });

  it("publishing without a source or verified date is refused with the reasons, and is not audited as a publish", async () => {
    const s = slug();
    await opCreate(ADMIN, req("POST", { slug: s, ...rule({ sourceUrl: "", sourceTitle: "", lastVerified: null }) }), deps);
    const r = await json(await opAction(ADMIN, req("POST", {}), deps, s, "publish"));
    expect(r.status).toBe(400);
    expect(r.data.problems.join(" ")).toMatch(/source URL/);
    expect(r.data.problems.join(" ")).toMatch(/last-verified/);
    expect((await auditRows(s)).map((a) => a.action)).toEqual(["admin.compliance.rule.create"]);
    expect((await json(await opAction(ADMIN, req("POST", {}), deps, s, "check"))).status).toBe(400); // nothing to check
  });

  it("validates input: bad JSON, bad conditions, bad slug, http URL, unknown rule, unknown action", async () => {
    const bad = (body: unknown) => opCreate(ADMIN, new Request("http://localhost/x", { method: "POST", headers: { host: "localhost" }, body: typeof body === "string" ? body : JSON.stringify(body) }), deps);
    expect((await bad("not json")).status).toBe(400);
    expect((await bad({ slug: slug(), ...rule({ conditions: [{ type: "nope" }] }) })).status).toBe(400);
    expect((await bad({ slug: "Bad Slug", ...rule() })).status).toBe(400);
    expect((await bad({ slug: slug(), ...rule({ sourceUrl: "http://insecure.example.gov" }) })).status).toBe(400);
    expect((await opGet(ADMIN, req("GET"), deps, "api-does-not-exist")).status).toBe(404);
    expect((await opGet(ADMIN, req("GET"), deps, "Bad Slug")).status).toBe(404);
    expect((await opUpdate(ADMIN, req("PATCH", rule()), deps, "api-does-not-exist")).status).toBe(404);
    const s = slug();
    await opCreate(ADMIN, req("POST", { slug: s, ...rule() }), deps);
    expect((await opAction(ADMIN, req("POST", {}), deps, s, "delete")).status).toBe(404);
    expect((await opCreate(ADMIN, req("POST", { slug: s, ...rule() }), deps)).status).toBe(409);
  });

  it("source check never contacts a private address and records what happened", async () => {
    const s = slug();
    await opCreate(ADMIN, req("POST", { slug: s, ...rule({ sourceUrl: "https://internal.example.org/x" }) }), deps);
    const before = requested.length;
    const r = await json(await opAction(ADMIN, req("POST", {}), deps, s, "check"));
    expect(r.status).toBe(200);
    expect(r.data.result).toMatchObject({ ok: false, status: null, blocked: "private" });
    expect(requested.length).toBe(before);
    expect(r.data.rule.lastCheck).toMatchObject({ status: null });
    // redirects are followed and the final URL is reported
    await opUpdate(ADMIN, req("PATCH", rule({ sourceUrl: "https://www.example.gov/moved" })), deps, s);
    const moved = await json(await opAction(ADMIN, req("POST", {}), deps, s, "check"));
    expect(moved.data.result).toMatchObject({ ok: true, status: 200, finalUrl: "https://www.example.gov/final", redirects: 1 });
    expect((await auditRows(s)).filter((a) => a.action.endsWith("source_check"))).toHaveLength(2);
  });

  it("preview evaluates unsaved content against the sample businesses and reports invalid content", async () => {
    const ok = await json(await opPreview(ADMIN, req("POST", rule({ conditions: [{ type: "state", is: "TX" }] }))));
    expect(ok.status).toBe(200);
    expect(ok.data.rows).toHaveLength(6);
    expect(ok.data.rows.filter((r: { applies: boolean }) => r.applies).map((r: { key: string }) => r.key)).toEqual(["tx-solo-contractors"]);
    expect((await opPreview(ADMIN, req("POST", rule({ conditions: [{ type: "state", is: "ZZ" }] })))).status).toBe(400);
    expect((await opPreview(ADMIN, req("POST", { nonsense: true }))).status).toBe(400);
  });

  it("list returns admin rules, the read-only built-in rules with their sources, and the stale queue (oldest first)", async () => {
    const s = slug();
    await opCreate(ADMIN, req("POST", { slug: s, ...rule({ lastVerified: "2020-01-01" }) }), deps);
    const l = await json(await opList(ADMIN, req("GET"), deps));
    expect(l.status).toBe(200);
    expect(l.data.rules.some((r: { slug: string }) => r.slug === s)).toBe(true);
    expect(l.data.seed.length).toBeGreaterThan(50);
    expect(l.data.seed[0]).toMatchObject({ ruleId: expect.any(String), sourceUrl: expect.stringMatching(/^https:/), lastVerified: expect.anything() });
    const stale = l.data.stale as { ruleId: string; lastVerified: string | null; origin: string }[];
    const mine = stale.find((e) => e.ruleId === `admin:${s}`);
    expect(mine).toMatchObject({ origin: "admin", lastVerified: "2020-01-01" });
    const dates = stale.map((e) => e.lastVerified ?? "");
    expect([...dates].sort()).toEqual(dates);
    // verify from the queue
    expect((await json(await opAction(ADMIN, req("POST", {}), deps, s, "verify"))).data.rule.content.lastVerified).toBe(today);
    const after = await json(await opList(ADMIN, req("GET"), deps));
    expect(after.data.stale.some((e: { ruleId: string }) => e.ruleId === `admin:${s}`)).toBe(false);
  });
});
