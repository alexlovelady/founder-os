import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { TOOLS } from "../../src/lib/tools/registry";
import { DEMO_NAME, assertSafeDatabase, seedDemo } from "../../scripts/seed-demo";

describe("assertSafeDatabase", () => {
  it.each([
    "postgresql://u:p@localhost:5442/founderos",
    "postgresql://u:p@127.0.0.1:5432/x",
    "postgresql://u:p@[::1]:5432/x",
    "postgres://u:p@db.localhost/x",
  ])("allows %s", (url) => expect(() => assertSafeDatabase(url)).not.toThrow());

  it.each([
    "postgresql://u:p@shinkansen.proxy.rlwy.net:12345/railway",
    "postgresql://u:p@postgres.railway.internal:5432/railway",
    "postgresql://u:p@evil.example.com:5432/localhost",
    "postgresql://localhost:x@evil.example.com/127.0.0.1",
    "postgresql://u:p@localhost.evil.com/x",
    "not a url",
    "",
  ])("refuses %s", (url) => expect(() => assertSafeDatabase(url)).toThrow());

  it("allows a remote database only with the explicit flag", () => {
    expect(() => assertSafeDatabase("postgresql://u:p@db.example.com/x", true)).not.toThrow();
  });
});

describe("seedDemo", () => {
  let env: TestEnv;
  const owner = `demo-owner-${Date.now()}`;
  let businessId = "";

  beforeAll(async () => {
    env = await makeTestEnv(TOOLS);
  });
  afterAll(async () => {
    if (businessId) await env.sql`DELETE FROM businesses WHERE id = ${businessId}`;
    await env.cleanup();
  });

  const counts = async () => {
    const q = async (t: string) => Number((await env.sql.unsafe(`SELECT count(*)::int AS n FROM ${t} WHERE business_id = $1`, [businessId]))[0].n);
    return {
      documents: await q("vault_documents"), versions: await q("vault_versions"), tasks: await q("tasks_items"), contacts: await q("crm_contacts"),
      opportunities: await q("crm_opportunities"), sops: await q("sops_documents"), calculations: await q("finance_calculations"),
      competitors: await q("competitors_items"), compliance: await q("compliance_items"),
    };
  };

  it("creates the demo business and its data", async () => {
    const r = await seedDemo(env.sql, owner);
    businessId = r.businessId;
    expect(r.created).toMatchObject({ documents: 3, tasks: 6, contacts: 8, opportunities: 3, sops: 2, calculations: 5, competitors: 1 });
    const [b] = await env.sql`SELECT * FROM businesses WHERE id = ${businessId}`;
    expect(b.name).toBe(DEMO_NAME);
    expect(b.state).toBe("North Carolina");
    expect(b.employee_count).toBe(2);
    expect(b.operations.usesContractors).toBe(true);
    expect(b.operations.hasWebsite).toBe(true);
    const [m] = await env.sql`SELECT role FROM business_members WHERE business_id = ${businessId} AND user_id = ${owner}`;
    expect(m.role).toBe("owner");
    const c = await counts();
    expect(c).toMatchObject({ documents: 3, versions: 3, tasks: 6, contacts: 8, opportunities: 3, sops: 2, calculations: 5, competitors: 1 });
    expect(c.compliance).toBeGreaterThan(0);
  });

  it("stores real, downloadable text files in the vault", async () => {
    const rows = await env.sql`SELECT name, size, sha256, content_type FROM vault_documents WHERE business_id = ${businessId} ORDER BY name`;
    expect(rows.map((r) => r.name)).toEqual(["Customer Service Agreement", "Independent Contractor Agreement", "Privacy Policy"]);
    for (const r of rows) {
      expect(Number(r.size)).toBeGreaterThan(200);
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is idempotent: running again duplicates nothing", async () => {
    const before = await counts();
    const again = await seedDemo(env.sql, owner);
    expect(again.businessId).toBe(businessId);
    expect(again.created).toEqual({});
    expect(again.existing).toMatchObject({ documents: 3, tasks: 6, contacts: 8, opportunities: 3, sops: 2, calculations: 5, competitors: 1 });
    expect(await counts()).toEqual(before);
    const [{ n }] = await env.sql`SELECT count(*)::int AS n FROM businesses b JOIN business_members m ON m.business_id = b.id WHERE m.user_id = ${owner}`;
    expect(n).toBe(1);
  });

  it("repairs a deleted item on the next run without touching the rest", async () => {
    await env.sql`DELETE FROM tasks_items WHERE business_id = ${businessId} AND title LIKE 'Update the website%'`;
    const r = await seedDemo(env.sql, owner);
    expect(r.created).toEqual({ tasks: 1 });
  });

  it("keeps different owners' demo businesses separate", async () => {
    const other = `${owner}-b`;
    const r = await seedDemo(env.sql, other);
    try {
      expect(r.businessId).not.toBe(businessId);
      expect(r.created.contacts).toBe(8);
    } finally {
      await env.sql`DELETE FROM businesses WHERE id = ${r.businessId}`;
    }
  });
});
