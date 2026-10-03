import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HttpError, type ToolContext } from "@founderos/sdk";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { reviewInLegal, type BridgeDeps } from "../../../shell/src/lib/legalbridge/bridge";
import { tool } from "../src/index";
import { docx } from "./fixtures";

const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEGAL_DOC = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REVIEW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const session = { cookie: "sid=abc123", csrf: "csrf-token-xyz" };

interface Seen { method: string; path: string; headers: Record<string, string>; body: unknown }
type Reply = Response | ((seen: Seen) => Response | Promise<Response>);

/** A scripted LegalAI: replies keyed "METHOD /path" (later entries repeat). No network. */
function fakeLegal(replies: Record<string, Reply | Reply[]>) {
  const seen: Seen[] = [];
  const counters: Record<string, number> = {};
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    const s: Seen = { method: init.method ?? "GET", path: u.pathname, headers: init.headers as Record<string, string>, body: init.body };
    seen.push(s);
    const r = replies[key] ?? replies[`${init.method ?? "GET"} ${u.pathname.replace(/[0-9a-f-]{36}/, ":id")}`];
    if (!r) return new Response(JSON.stringify({ detail: "unexpected call " + key }), { status: 599 });
    const list = Array.isArray(r) ? r : [r];
    const i = Math.min(counters[key] ?? 0, list.length - 1);
    counters[key] = (counters[key] ?? 0) + 1;
    const pick = list[i];
    return typeof pick === "function" ? pick(s) : pick.clone();
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}
const j = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const parsed = (status = "parsed") => j({ id: LEGAL_DOC, current_version: { parse_status: status } });
const deps = (fetchImpl: typeof fetch, extra: Partial<BridgeDeps> = {}): BridgeDeps => ({ fetch: fetchImpl, legalUrl: "http://legal.test", sleep: async () => {}, ...extra });

describe("vault to LegalAI bridge", () => {
  let env: TestEnv;
  let docId: string;
  const bytes = docx(["MASTER SERVICES AGREEMENT", "The vendor will deliver the services described in each statement of work."]);
  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(bytes)], "Acme MSA.docx"));
    const r = await tool.api!(env.ctx, new Request("http://t/x", { method: "POST", body: fd }), ["documents"]);
    docId = (await r.json()).document.id;
  });
  afterAll(async () => {
    await env.cleanup();
  });
  const run = (ctx: ToolContext, d: BridgeDeps, over: Partial<Parameters<typeof reviewInLegal>[0]> = {}) =>
    reviewInLegal({ ctx, tool, documentId: docId, perspective: "vendor", workspaceId: WORKSPACE, session, ...over }, d);

  it("uploads the exact file as multipart, starts the review with the user's cookie and CSRF token, and stores the link", async () => {
    const quota = vi.fn(async () => {});
    env.ctx.useQuota = quota;
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const legal = fakeLegal({ "POST /api/documents": j({ id: LEGAL_DOC }, 201), "GET /api/documents/:id": parsed(), "POST /api/contracts/review": j({ id: REVIEW, status: "queued" }, 202) });
    const r = await run(env.ctx, deps(legal.fetchImpl));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ state: "started", legalDocumentId: LEGAL_DOC, reviewId: REVIEW, perspective: "vendor", openUrl: "/legal-ui/", linkSaved: true });

    const [up, check, review] = legal.seen;
    expect(up).toMatchObject({ method: "POST", path: "/api/documents" });
    expect(up.headers).toMatchObject({ cookie: session.cookie, "x-csrf-token": session.csrf });
    expect(up.headers["content-type"]).toBeUndefined(); // fetch adds the multipart boundary itself
    const fd = up.body as FormData;
    expect(fd.get("matter_id")).toBe(WORKSPACE);
    const file = fd.get("file") as File;
    expect(file.name).toBe("Acme MSA.docx");
    expect(file.type).toContain("wordprocessingml");
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
    expect(check).toMatchObject({ method: "GET", path: `/api/documents/${LEGAL_DOC}` });
    expect(check.headers.cookie).toBe(session.cookie);
    expect(check.headers["x-csrf-token"]).toBeUndefined(); // reads carry no CSRF token
    expect(review).toMatchObject({ method: "POST", path: "/api/contracts/review" });
    expect(review.headers).toMatchObject({ cookie: session.cookie, "x-csrf-token": session.csrf, "content-type": "application/json" });
    expect(JSON.parse(review.body as string)).toEqual({ document_id: LEGAL_DOC, perspective: "vendor" });
    expect(quota).toHaveBeenCalledTimes(1);
    expect(quota).toHaveBeenCalledWith("aiRequestsPerMonth");

    const detail = (await call(tool, env.ctx, "GET", `documents/${docId}`)).data;
    expect(detail.legalLink).toMatchObject({ legalDocumentId: LEGAL_DOC, legalReviewId: REVIEW, perspective: "vendor", version: 1 });
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_legal_links WHERE document_id = ${docId}`;
    expect(n).toBe(1);
    // Document contents and cookies never reach the logs.
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
    logs.forEach((s) => s.mockRestore());
  });

  it("does not upload the same version twice: a second review reuses the LegalAI document", async () => {
    const legal = fakeLegal({ "GET /api/documents/:id": parsed(), "POST /api/contracts/review": j({ id: REVIEW }, 202) });
    const r = await run(env.ctx, deps(legal.fetchImpl), { perspective: "customer" });
    expect(r.status).toBe(201);
    expect(legal.seen.map((s) => `${s.method} ${s.path}`)).toEqual([`GET /api/documents/${LEGAL_DOC}`, "POST /api/contracts/review"]);
    // If LegalAI no longer has it, the file is uploaded again.
    const gone = fakeLegal({ "GET /api/documents/:id": [j({ detail: "Document not found" }, 404), parsed()], "POST /api/documents": j({ id: LEGAL_DOC }, 201), "POST /api/contracts/review": j({ id: REVIEW }, 202) });
    expect((await run(env.ctx, deps(gone.fetchImpl))).status).toBe(201);
    expect(gone.seen.some((s) => s.method === "POST" && s.path === "/api/documents")).toBe(true);
  });

  it("forbids viewers, other businesses, bad input and missing setup before touching LegalAI", async () => {
    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      const legal = fakeLegal({});
      const d = deps(legal.fetchImpl);
      const v = await run(viewer.ctx, d);
      expect(v.status).toBe(403);
      expect(v.body.error).toMatch(/role cannot/);
      expect((await run(env.other, d)).status).toBe(404); // another business's document does not exist for them
      expect((await run(env.ctx, d, { documentId: "not-a-uuid" })).status).toBe(404);
      expect((await run(env.ctx, d, { perspective: "judge" })).status).toBe(400);
      const none = await run(env.ctx, d, { workspaceId: undefined });
      expect(none.status).toBe(409);
      expect(none.body.error).toMatch(/not set up/);
      expect(legal.seen).toEqual([]);
    } finally {
      await viewer.cleanup();
    }
  });

  it("maps LegalAI failures to clear messages", async () => {
    const fresh = async () => {
      await env.sql`DELETE FROM vault_legal_links WHERE document_id = ${docId}`; // so each case starts with an upload
    };
    const up = (reply: Reply) => fakeLegal({ "POST /api/documents": reply });

    await fresh();
    const down = await run(env.ctx, deps((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch));
    expect(down.status).toBe(502);
    expect(down.body.error).toMatch(/could not be reached/);

    expect((await run(env.ctx, deps(up(j({ detail: "Not authenticated" }, 401)).fetchImpl)))).toMatchObject({ status: 401, body: { error: expect.stringMatching(/session has expired/) } });
    expect((await run(env.ctx, deps(up(j({ detail: "no" }, 403)).fetchImpl))).status).toBe(403);
    expect((await run(env.ctx, deps(up(j({ detail: "File exceeds 25 MB limit" }, 413)).fetchImpl)))).toMatchObject({ status: 413, body: { error: expect.stringMatching(/too large/) } });
    const rejected = await run(env.ctx, deps(up(j({ detail: "Files of type .exe are not allowed" }, 422)).fetchImpl));
    expect(rejected.status).toBe(422);
    expect(rejected.body.error).toContain("Files of type .exe are not allowed");
    expect((await run(env.ctx, deps(up(j({ detail: "Matter not found" }, 404)).fetchImpl))).status).toBe(409);
    expect((await run(env.ctx, deps(up(j({ detail: "x" }, 429)).fetchImpl))).status).toBe(429);
    const boom = await run(env.ctx, deps(up(new Response("<html>boom</html>", { status: 500 })).fetchImpl));
    expect(boom.status).toBe(502);
    expect(JSON.stringify(boom.body)).not.toContain("boom");
    // Nothing was recorded for the failures.
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_legal_links WHERE document_id = ${docId}`;
    expect(n).toBe(0);

    // LegalAI could not read the file.
    const bad = fakeLegal({ "POST /api/documents": j({ id: LEGAL_DOC }, 201), "GET /api/documents/:id": parsed("failed") });
    expect((await run(env.ctx, deps(bad.fetchImpl)))).toMatchObject({ status: 422, body: { error: expect.stringMatching(/could not read this file/) } });
    // Review endpoint errors.
    await fresh();
    const rv401 = fakeLegal({ "POST /api/documents": j({ id: LEGAL_DOC }, 201), "GET /api/documents/:id": parsed(), "POST /api/contracts/review": j({ detail: "Not authenticated" }, 401) });
    expect((await run(env.ctx, deps(rv401.fetchImpl))).status).toBe(401);
  });

  it("returns 'still reading' instead of failing when LegalAI is slow to parse, and the retry skips the upload", async () => {
    await env.sql`DELETE FROM vault_legal_links WHERE document_id = ${docId}`;
    const slow = fakeLegal({ "POST /api/documents": j({ id: LEGAL_DOC }, 201), "GET /api/documents/:id": parsed("pending") });
    const sleeps: number[] = [];
    const r = await run(env.ctx, deps(slow.fetchImpl, { parseChecks: 3, parseIntervalMs: 500, sleep: async (ms) => { sleeps.push(ms); } }));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ state: "processing", legalDocumentId: LEGAL_DOC });
    expect(slow.seen.filter((s) => s.path === `/api/documents/${LEGAL_DOC}`)).toHaveLength(3);
    expect(sleeps).toEqual([500, 500]);
    expect(slow.seen.some((s) => s.path === "/api/contracts/review")).toBe(false);
    const detail = (await call(tool, env.ctx, "GET", `documents/${docId}`)).data;
    expect(detail.legalLink).toMatchObject({ legalDocumentId: LEGAL_DOC, legalReviewId: null });

    // LegalAI says 409 "not ready" on the review itself: same friendly outcome.
    const notReady = fakeLegal({ "GET /api/documents/:id": parsed(), "POST /api/contracts/review": j({ detail: "Document is not ready for review (status: pending)" }, 409) });
    expect((await run(env.ctx, deps(notReady.fetchImpl))).status).toBe(202);

    // Retry once it is ready: no second upload.
    const ready = fakeLegal({ "GET /api/documents/:id": parsed(), "POST /api/contracts/review": j({ id: REVIEW }, 202) });
    const again = await run(env.ctx, deps(ready.fetchImpl));
    expect(again.status).toBe(201);
    expect(ready.seen.some((s) => s.method === "POST" && s.path === "/api/documents")).toBe(false);
  });

  it("stops before starting the review when the plan's AI limit is reached", async () => {
    env.ctx.useQuota = async () => { throw new HttpError(402, "You have used all of this month's AI requests."); };
    const legal = fakeLegal({ "GET /api/documents/:id": parsed(), "POST /api/contracts/review": j({ id: REVIEW }, 202) });
    const r = await run(env.ctx, deps(legal.fetchImpl));
    expect(r.status).toBe(402);
    expect(r.body.error).toMatch(/AI requests/);
    expect(legal.seen.some((s) => s.path === "/api/contracts/review")).toBe(false);
    env.ctx.useQuota = async () => {};
  });
});
