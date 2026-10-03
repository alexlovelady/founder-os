import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolAction } from "@founderos/sdk";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";

const action = (id: string): ToolAction => tool.actions!.find((a) => a.id === id)!;
const KEY = "fp:vault-key-1";
const NOPE = "00000000-0000-4000-8000-000000000000";

describe("vault actions (assistant proposals)", () => {
  let env: TestEnv;
  let viewer: TestEnv;
  let docId: string;
  const row = async (id: string) => (await env.sql`SELECT tags, to_char(expiration_date, 'YYYY-MM-DD') AS exp, name FROM vault_documents WHERE id = ${id}`)[0];

  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    viewer = await makeTestEnv([tool], { role: "viewer" });
    const [d] = await env.sql<{ id: string }[]>`
      INSERT INTO vault_documents (business_id, name, original_filename, category, tags, sha256, size, content_type, uploaded_by)
      VALUES (${env.ctx.businessId}, 'Insurance policy', 'policy.pdf', 'Insurance', ${["policy"]}, 'abc', 10, 'application/pdf', 'u') RETURNING id`;
    docId = d.id;
  });
  afterAll(async () => {
    await env.cleanup();
    await viewer.cleanup();
  });

  it("declares the proposed actions, none destructive", () => {
    expect(tool.actions!.map((a) => a.id)).toEqual(["set_document_expiration", "add_document_tag"]);
  });

  it("set_document_expiration: validates, previews without changing, sets and clears", async () => {
    const a = action("set_document_expiration");
    expect(a.input.safeParse({ documentId: docId, expirationDate: "2027-02-30" }).success).toBe(false);
    expect(a.input.safeParse({ documentId: "x", expirationDate: null }).success).toBe(false);
    const p = await a.preview(env.ctx, { documentId: docId, expirationDate: "2027-06-30" });
    expect(p.details).toMatchObject({ "Old expiration": "none", "New expiration": "2027-06-30" });
    expect((await row(docId)).exp).toBeNull();
    const ctx = { ...env.ctx, idempotencyKey: KEY };
    await a.run(ctx, { documentId: docId, expirationDate: "2027-06-30" });
    await a.run(ctx, { documentId: docId, expirationDate: "2027-06-30" });
    expect((await row(docId)).exp).toBe("2027-06-30");
    await a.run(ctx, { documentId: docId, expirationDate: null });
    expect((await row(docId)).exp).toBeNull();
  });

  it("add_document_tag: adds one normalised tag, keeps the rest, never duplicates", async () => {
    const a = action("add_document_tag");
    expect(a.input.safeParse({ documentId: docId, tag: "  " }).success).toBe(false);
    expect((await a.preview(env.ctx, { documentId: docId, tag: "Renewal  Due" })).summary).toContain("renewal due");
    expect((await row(docId)).tags).toEqual(["policy"]);
    const ctx = { ...env.ctx, idempotencyKey: KEY };
    await a.run(ctx, { documentId: docId, tag: "Renewal  Due" });
    await a.run(ctx, { documentId: docId, tag: "renewal due" });
    expect((await row(docId)).tags).toEqual(["policy", "renewal due"]);
    expect((await a.preview(env.ctx, { documentId: docId, tag: "policy" })).summary).toMatch(/nothing would change/);
  });

  it("never touches another business's documents", async () => {
    for (const [aid, input] of [["set_document_expiration", { documentId: docId, expirationDate: "2030-01-01" }], ["add_document_tag", { documentId: docId, tag: "hijack" }]] as const) {
      await expect(action(aid).preview(env.other, input)).rejects.toMatchObject({ status: 404 });
      await expect(action(aid).run(env.other, input)).rejects.toMatchObject({ status: 404 });
    }
    const r = await row(docId);
    expect(r.exp).toBeNull();
    expect(r.tags).not.toContain("hijack");
    await expect(action("add_document_tag").preview(env.ctx, { documentId: NOPE, tag: "x" })).rejects.toMatchObject({ status: 404 });
  });

  it("viewers cannot run any action", async () => {
    await expect(action("set_document_expiration").run(viewer.ctx, { documentId: NOPE, expirationDate: null })).rejects.toMatchObject({ status: 403 });
    await expect(action("add_document_tag").run(viewer.ctx, { documentId: NOPE, tag: "x" })).rejects.toMatchObject({ status: 403 });
  });
});
