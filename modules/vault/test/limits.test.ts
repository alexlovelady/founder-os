import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "@founderos/sdk";
import { call, FakeAi, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";
import { withPlan } from "./limited";

const pdf = (extraBytes = 0) => Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n"), Buffer.alloc(extraBytes, 32), Buffer.from("\n%%EOF")]);

async function upload(ctx: ToolContext, filename: string, bytes: Buffer, path = "documents") {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], filename));
  const res = await tool.api!(ctx, new Request(`http://test/api/tools/vault/${path}`, { method: "POST", body: fd }), path.split("/"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

describe("vault plan limits", () => {
  let env: TestEnv;
  const usedMb = async (k: string) =>
    k === "storageMb" ? Number((await env.sql<{ mb: string }[]>`SELECT (COALESCE(SUM(octet_length(data)), 0) / 1048576.0)::text AS mb FROM vault_blobs WHERE business_id = ${env.ctx.businessId}`)[0].mb) : 0;

  beforeAll(async () => {
    env = await makeTestEnv([tool], { ai: new FakeAi(["A summary."]) });
  });
  afterAll(async () => {
    await env.cleanup();
  });

  it("refuses an upload that would pass the plan storage with a 402, stores nothing, and counts new versions too", async () => {
    const { ctx, calls } = withPlan(env.ctx, { limits: { storageMb: 1 }, stock: usedMb });
    const a = await upload(ctx, "first.pdf", pdf(600 * 1024));
    expect(a.status).toBe(201);
    expect(calls[0]).toEqual(["storage_bytes", pdf(600 * 1024).length]);
    const b = await upload(ctx, "second.pdf", pdf(600 * 1024));
    expect(b.status).toBe(402);
    expect(b.data.error).toMatch(/MB of document storage/);
    const [{ n }] = await env.sql`SELECT count(*)::int AS n FROM vault_documents WHERE business_id = ${env.ctx.businessId}`;
    expect(n).toBe(1);
    const v = await upload(ctx, "first-v2.pdf", pdf(600 * 1024), `documents/${a.data.document.id}/versions`);
    expect(v.status).toBe(402);
    const [{ blobs }] = await env.sql`SELECT count(*)::int AS blobs FROM vault_blobs WHERE business_id = ${env.ctx.businessId}`;
    expect(blobs).toBe(1);
    // A small file still fits under the limit, as a new document and as a new version.
    expect((await upload(ctx, "small.pdf", pdf(1000))).status).toBe(201);
    expect((await upload(ctx, "small-v2.pdf", pdf(2000), `documents/${a.data.document.id}/versions`)).status).toBe(201);
  });

  it("does not meter downloads or reads, and a plan without a storage limit never blocks", async () => {
    const { ctx, calls } = withPlan(env.ctx, { limits: { storageMb: 0 }, stock: usedMb });
    expect((await call(tool, ctx, "GET", "documents")).status).toBe(200);
    expect(calls).toHaveLength(0);
    const free = withPlan(env.ctx, { limits: { storageMb: null }, stock: usedMb });
    expect((await upload(free.ctx, "unlimited.pdf", pdf(5000))).status).toBe(201);
  });

  it("counts one ai_request per summary and a 402 starts no AI job", async () => {
    const id = (await upload(env.ctx, "note.txt", Buffer.from("A short note about the lease renewal."))).data.document.id;
    const { ctx, calls } = withPlan(env.ctx, { limits: { aiRequestsPerMonth: 1 } });
    expect((await call(tool, ctx, "POST", `documents/${id}/summary`)).status).toBe(202);
    const before = env.ai.calls.length;
    const blocked = await call(tool, ctx, "POST", `documents/${id}/summary`);
    expect(blocked.status).toBe(402);
    expect(blocked.data.error).toMatch(/AI requests a month/);
    expect(env.ai.calls).toHaveLength(before);
    expect(calls.map(([m]) => m)).toEqual(["ai_request", "ai_request"]);
  });
});
