import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolAction } from "@founderos/sdk";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";

const action = (id: string): ToolAction => tool.actions!.find((a) => a.id === id)!;
const KEY = "fp:crm-key-1";
const NOPE = "00000000-0000-4000-8000-000000000000";

describe("crm actions (assistant proposals)", () => {
  let env: TestEnv;
  let viewer: TestEnv;
  let contactId: string;
  let oppId: string;
  const n = async (table: string) => (await env.sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE business_id = $1`, [env.ctx.businessId]))[0].n as number;

  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    viewer = await makeTestEnv([tool], { role: "viewer" });
    contactId = (await call(tool, env.ctx, "POST", "contacts", { name: "Acme Plumbing", email: "ops@acme.test" })).data.contact.id;
    oppId = (await call(tool, env.ctx, "POST", "opportunities", { contactId, title: "Acme retainer", valueCents: 500000 })).data.opportunity.id;
  });
  afterAll(async () => {
    await env.cleanup();
    await viewer.cleanup();
  });

  it("declares the proposed actions, none destructive or external", () => {
    expect(tool.actions!.map((a) => a.id)).toEqual(["add_contact", "add_note", "move_opportunity_stage"]);
  });

  it("add_contact: preview is read-only; run adds the contact once per key; duplicate email is refused", async () => {
    const a = action("add_contact");
    const input = a.input.parse({ name: "Bright Supply", email: "hi@bright.test", type: "vendor" });
    const before = await n("crm_contacts");
    expect((await a.preview(env.ctx, input)).summary).toContain("Bright Supply");
    expect(await n("crm_contacts")).toBe(before);
    const ctx = { ...env.ctx, idempotencyKey: KEY };
    const r1 = await a.run(ctx, input);
    const r2 = await a.run(ctx, input);
    expect(r2.href).toBe(r1.href);
    expect(await n("crm_contacts")).toBe(before + 1);
    expect((await env.sql`SELECT type FROM crm_contacts WHERE id = ${r1.href!.split("/").pop()!}`)[0].type).toBe("vendor");
    // a different proposal for the same email hits the CRM's own duplicate rule
    await expect(a.run({ ...env.ctx, idempotencyKey: "fp:other" }, input)).rejects.toMatchObject({ status: 409 });
    expect((await a.preview(env.ctx, input)).summary).toMatch(/already exists/);
  });

  it("add_note: to a contact or an opportunity, exactly one target, idempotent per key", async () => {
    const a = action("add_note");
    expect(a.input.safeParse({ body: "x" }).success).toBe(false);
    expect(a.input.safeParse({ contactId, opportunityId: oppId, body: "x" }).success).toBe(false);
    expect(a.input.safeParse({ contactId, body: "  " }).success).toBe(false);
    const before = await n("crm_notes");
    expect((await a.preview(env.ctx, { contactId, body: "Called, wants a quote" })).summary).toContain("Acme Plumbing");
    expect(await n("crm_notes")).toBe(before);
    const ctx = { ...env.ctx, idempotencyKey: KEY };
    await a.run(ctx, { contactId, body: "Called, wants a quote" });
    await a.run(ctx, { contactId, body: "Called, wants a quote" });
    await a.run(ctx, { opportunityId: oppId, body: "Sent the proposal draft" });
    expect(await n("crm_notes")).toBe(before + 2);
    const opp = await env.sql`SELECT opportunity_id FROM crm_notes WHERE body = 'Sent the proposal draft'`;
    expect(opp[0].opportunity_id).toBe(oppId);
  });

  it("move_opportunity_stage: preview shows from/to, lost needs a reason, repeat is a no-op", async () => {
    const a = action("move_opportunity_stage");
    expect(a.input.safeParse({ opportunityId: oppId, stage: "lost" }).success).toBe(false);
    expect(a.input.safeParse({ opportunityId: oppId, stage: "closed" }).success).toBe(false);
    const p = await a.preview(env.ctx, { opportunityId: oppId, stage: "negotiation" });
    expect(p.details).toMatchObject({ From: "lead", To: "negotiation" });
    expect((await env.sql`SELECT stage FROM crm_opportunities WHERE id = ${oppId}`)[0].stage).toBe("lead");
    const ctx = { ...env.ctx, idempotencyKey: KEY };
    await a.run(ctx, { opportunityId: oppId, stage: "negotiation" });
    await a.run(ctx, { opportunityId: oppId, stage: "negotiation" });
    expect((await env.sql`SELECT stage FROM crm_opportunities WHERE id = ${oppId}`)[0].stage).toBe("negotiation");
    expect(await n("crm_stage_history")).toBe(2); // created + one move
    await a.run(ctx, { opportunityId: oppId, stage: "lost", lostReason: "Chose a competitor" });
    expect((await env.sql`SELECT stage, lost_reason FROM crm_opportunities WHERE id = ${oppId}`)[0]).toMatchObject({ stage: "lost", lost_reason: "Chose a competitor" });
  });

  it("never touches another business's records", async () => {
    for (const [aid, input] of [
      ["add_note", { contactId, body: "sneaky" }],
      ["add_note", { opportunityId: oppId, body: "sneaky" }],
      ["move_opportunity_stage", { opportunityId: oppId, stage: "won" }],
    ] as const) {
      await expect(action(aid).preview(env.other, input)).rejects.toMatchObject({ status: 404 });
      await expect(action(aid).run(env.other, input)).rejects.toMatchObject({ status: 404 });
    }
    await expect(action("add_note").preview(env.ctx, { contactId: NOPE, body: "x" })).rejects.toMatchObject({ status: 404 });
    expect((await env.sql`SELECT count(*)::int AS c FROM crm_notes WHERE body = 'sneaky'`)[0].c).toBe(0);
  });

  it("viewers cannot run any action", async () => {
    for (const [aid, input] of [["add_contact", { name: "X" }], ["add_note", { contactId: NOPE, body: "x" }], ["move_opportunity_stage", { opportunityId: NOPE, stage: "won" }]] as const) {
      await expect(action(aid).run(viewer.ctx, input)).rejects.toMatchObject({ status: 403 });
    }
  });
});
