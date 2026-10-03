import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolContext } from "@founderos/sdk";
import { call, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { keyDocumentFlags } from "../src/facts";
import { attachmentHeader, FileRejected, MAX_BYTES, sanitizeFilename, validateFile } from "../src/files";
import { tool } from "../src/index";

const pdf = (extra = "") => Buffer.from(`%PDF-1.4\n1 0 obj<<>>endobj\n${extra}\n%%EOF`);
const zip = (parts: string[]) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), ...parts.map((p) => Buffer.from(`\0\0${p}\0`))]);
const docx = (extra = "") => zip(["[Content_Types].xml", "word/document.xml", extra]);
const xlsx = () => zip(["[Content_Types].xml", "xl/workbook.xml"]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
const jpg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

async function upload(ctx: ToolContext, filename: string, bytes: Buffer, fields: Record<string, string> = {}, path = "documents", type?: string) {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], filename, { type }));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const req = new Request(`http://test/api/tools/vault/${path}`, { method: "POST", body: fd });
  const res = await tool.api!(ctx, req, path.split("/"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
async function download(ctx: ToolContext, id: string, version?: number) {
  const q = version ? `?version=${version}` : "";
  return tool.api!(ctx, new Request(`http://test/api/tools/vault/documents/${id}/download${q}`), ["documents", id, "download"]);
}

describe("file rules", () => {
  it("sanitizes filenames", () => {
    expect(sanitizeFilename("../../etc/passwd.pdf")).toBe("passwd.pdf");
    expect(sanitizeFilename("C:\\Users\\me\\Plan <1>.pdf")).toBe("Plan _1_.pdf");
    expect(sanitizeFilename("...hidden.txt")).toBe("hidden.txt");
    expect(sanitizeFilename("a\u0000b\n.pdf")).toBe("ab.pdf");
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("x".repeat(300) + ".pdf").length).toBeLessThanOrEqual(120);
    expect(sanitizeFilename("x".repeat(300) + ".pdf").endsWith(".pdf")).toBe(true);
  });
  it("accepts real files of each type", () => {
    expect(validateFile("a.pdf", pdf())).toBe("pdf");
    expect(validateFile("a.docx", docx())).toBe("docx");
    expect(validateFile("a.xlsx", xlsx())).toBe("xlsx");
    expect(validateFile("a.png", png())).toBe("png");
    expect(validateFile("a.JPG", jpg())).toBe("jpg");
    expect(validateFile("a.jpeg", jpg())).toBe("jpeg");
    expect(validateFile("a.webp", Buffer.from("RIFF\x10\0\0\0WEBPVP8 "))).toBe("webp");
    expect(validateFile("a.txt", Buffer.from("hello"))).toBe("txt");
    expect(validateFile("a.csv", Buffer.from("a,b\n1,2"))).toBe("csv");
    expect(validateFile("a.md", Buffer.from("# hi"))).toBe("md");
    expect(validateFile("a.doc", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toBe("doc");
  });
  it("rejects mismatched, executable and unknown content", () => {
    const bad = (name: string, b: Buffer) => expect(() => validateFile(name, b)).toThrow(FileRejected);
    bad("a.pdf", png());
    bad("a.png", jpg());
    bad("a.jpg", png());
    bad("a.docx", zip(["random.txt"]));
    bad("a.docx", xlsx());
    bad("a.xlsx", docx());
    bad("a.pdf", Buffer.from("MZ\x90\0 fake exe"));
    bad("a.txt", Buffer.from("MZ\x90\0 fake exe"));
    bad("a.txt", Buffer.from("#!/bin/sh\nrm -rf /"));
    bad("a.txt", Buffer.from([0x68, 0x69, 0x00, 0x01]));
    bad("a.webp", Buffer.from("RIFF\x10\0\0\0WAVEfmt "));
    bad("run.exe", Buffer.from("MZ"));
    bad("a.svg", Buffer.from("<svg onload=alert(1)>"));
    bad("a.html", Buffer.from("<script>alert(1)</script>"));
    bad("noext", Buffer.from("hello"));
    bad("a.pdf", Buffer.alloc(0));
  });
  it("enforces the size cap and builds a safe disposition header", () => {
    expect(() => validateFile("a.txt", Buffer.alloc(MAX_BYTES + 1, 97))).toThrow(/15 MB/);
    expect(validateFile("a.txt", Buffer.alloc(MAX_BYTES, 97))).toBe("txt");
    const h = attachmentHeader('we"ird\r\nname é.pdf');
    expect(h.startsWith("attachment;")).toBe(true);
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).not.toMatch(/filename="[^"]*"[^;]*"/);
  });
  it("derives key-document flags from keywords", () => {
    const f = keyDocumentFlags([
      { name: "Acme LLC Operating-Agreement signed", doc_type: "", category: "Legal" },
      { name: "Website terms", doc_type: "Privacy Policy", category: "Policies" },
      { name: "GL policy 2026", doc_type: "insurance policy", category: "Insurance" },
      { name: "IRS CP 575 letter", doc_type: "", category: "Taxes" },
      { name: "Information sheet", doc_type: "", category: "Other" },
    ]);
    expect(f).toEqual({ hasOperatingAgreement: true, hasPrivacyPolicy: true, hasContractorAgreement: false, hasInsurance: true, hasFormationDocs: true, hasEin: true });
    const none = keyDocumentFlags([{ name: "Information sheet", doc_type: "", category: "Other" }]);
    expect(Object.values(none).every((v) => v === false)).toBe(true);
  });
});

describe("vault tool (database)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await makeTestEnv([tool]);
  });
  afterAll(async () => {
    await env.cleanup();
  });
  const day = async (offset: number) => (await env.sql<{ d: string }[]>`SELECT to_char(current_date + ${offset}::int, 'YYYY-MM-DD') AS d`)[0].d;

  let docId: string;
  const original = pdf("original contents");

  it("uploads a file with metadata and lists it", async () => {
    const r = await upload(env.ctx, "Operating Agreement v1.pdf", original, { category: "Formation", docType: "Operating Agreement", tags: "LLC, Signed, llc", expirationDate: await day(400) });
    expect(r.status).toBe(201);
    docId = r.data.document.id;
    expect(r.data.document).toMatchObject({
      name: "Operating Agreement v1", originalFilename: "Operating Agreement v1.pdf", category: "Formation", docType: "Operating Agreement", tags: ["llc", "signed"], status: "active", version: 1, size: original.length, contentType: "application/pdf", uploadedBy: env.ctx.userId,
    });
    expect(r.data.document.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.data.versions).toHaveLength(1);
    const list = await call(tool, env.ctx, "GET", "documents");
    expect(list.data.documents.map((d: { id: string }) => d.id)).toEqual([docId]);
    expect(list.data.categories).toEqual([{ category: "Formation", count: 1 }]);
    expect((await call(tool, env.ctx, "GET", `documents/${docId}`)).data.document.id).toBe(docId);
  });

  it("downloads as an attachment with safe headers and the exact bytes", async () => {
    const res = await download(env.ctx, docId);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Operating Agreement v1.pdf"/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(Buffer.from(await res.arrayBuffer()).equals(original)).toBe(true);
    // The stored blob has a random internal name, not the user's filename.
    const [b] = await env.sql<{ id: string }[]>`SELECT id FROM vault_blobs WHERE document_id = ${docId}`;
    expect(b.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("serves a hostile filename and content type safely", async () => {
    const r = await upload(env.ctx, "../../evil\r\nname.pdf", pdf("x"), { name: "Hostile" }, "documents", "text/html");
    expect(r.status).toBe(201);
    expect(r.data.document.originalFilename).toBe("evilname.pdf");
    expect(r.data.document.contentType).toBe("application/pdf");
    const res = await download(env.ctx, r.data.document.id);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).not.toMatch(/[\r\n]/);
    await call(tool, env.ctx, "DELETE", `documents/${r.data.document.id}`);
  });

  it("rejects bad uploads with clear messages", async () => {
    const mismatch = await upload(env.ctx, "fake.pdf", png());
    expect(mismatch.status).toBe(415);
    expect(mismatch.data.error).toMatch(/does not look like a real PDF/);
    const exe = await upload(env.ctx, "setup.exe", Buffer.from("MZ\x90\0"));
    expect(exe.status).toBe(415);
    expect(exe.data.error).toMatch(/not allowed/);
    expect((await upload(env.ctx, "x.docx", zip(["nothing"]))).status).toBe(415);
    const big = await upload(env.ctx, "big.pdf", Buffer.concat([pdf(), Buffer.alloc(MAX_BYTES)]));
    expect(big.status).toBe(413);
    expect(big.data.error).toMatch(/15 MB/);
    expect((await upload(env.ctx, "a.pdf", pdf(), { category: "Nonsense" })).status).toBe(400);
    expect((await upload(env.ctx, "a.pdf", pdf(), { expirationDate: "2026-13-01" })).status).toBe(400);
    const noFile = await tool.api!(env.ctx, new Request("http://test/x", { method: "POST", body: new FormData() }), ["documents"]);
    expect(noFile.status).toBe(400);
    const notForm = await call(tool, env.ctx, "POST", "documents", { hello: "world" });
    expect(notForm.status).toBe(400);
    const huge = await tool.api!(env.ctx, new Request("http://test/x", { method: "POST", headers: { "content-length": String(MAX_BYTES * 3) }, body: new FormData() }), ["documents"]);
    expect(huge.status).toBe(413);
    // Nothing was stored for any of the rejected uploads.
    expect((await call(tool, env.ctx, "GET", "documents")).data.documents).toHaveLength(1);
  });

  it("keeps version history and lets any version be downloaded", async () => {
    const v2 = pdf("second version, longer");
    const r = await upload(env.ctx, "Operating Agreement v2.pdf", v2, {}, `documents/${docId}/versions`);
    expect(r.status).toBe(201);
    expect(r.data.document).toMatchObject({ version: 2, originalFilename: "Operating Agreement v2.pdf", size: v2.length });
    expect(r.data.versions.map((v: { version: number; isCurrent: boolean }) => [v.version, v.isCurrent])).toEqual([[2, true], [1, false]]);
    expect(Buffer.from(await (await download(env.ctx, docId)).arrayBuffer()).equals(v2)).toBe(true);
    expect(Buffer.from(await (await download(env.ctx, docId, 2)).arrayBuffer()).equals(v2)).toBe(true);
    const first = await download(env.ctx, docId, 1);
    expect(Buffer.from(await first.arrayBuffer()).equals(original)).toBe(true);
    expect(first.headers.get("content-disposition")).toMatch(/Operating Agreement v1\.pdf/);
    expect((await download(env.ctx, docId, 9)).status).toBe(404);
    expect((await tool.api!(env.ctx, new Request(`http://test/x?version=abc`), ["documents", docId, "download"])).status).toBe(400);
    // A bad replacement is refused and does not bump the version.
    expect((await upload(env.ctx, "x.pdf", png(), {}, `documents/${docId}/versions`)).status).toBe(415);
    expect((await call(tool, env.ctx, "GET", `documents/${docId}`)).data.document.version).toBe(2);
  });

  it("renames, moves, tags and archives", async () => {
    const p = await call(tool, env.ctx, "PATCH", `documents/${docId}`, { name: "Operating Agreement (signed)", category: "Legal", tags: ["Signed", " 2026 "], docType: "Operating Agreement", status: "review", expirationDate: await day(20) });
    expect(p.data.document).toMatchObject({ name: "Operating Agreement (signed)", category: "Legal", tags: ["signed", "2026"], status: "review", expirationDate: await day(20), daysLeft: 20 });
    expect((await call(tool, env.ctx, "PATCH", `documents/${docId}`, { category: "Nope" })).status).toBe(400);
    expect((await call(tool, env.ctx, "PATCH", `documents/${docId}`, {})).status).toBe(400);
    expect((await call(tool, env.ctx, "PATCH", `documents/${docId}`, { expirationDate: null })).data.document.expirationDate).toBeNull();
    await call(tool, env.ctx, "PATCH", `documents/${docId}`, { status: "archived" });
    expect((await call(tool, env.ctx, "GET", "documents")).data.documents).toEqual([]);
    expect((await call(tool, env.ctx, "GET", "documents?status=archived")).data.documents).toHaveLength(1);
    expect((await call(tool, env.ctx, "GET", "documents?status=all")).data.documents).toHaveLength(1);
    await call(tool, env.ctx, "PATCH", `documents/${docId}`, { status: "active", expirationDate: await day(400) });
  });

  it("searches and filters", async () => {
    const insurance = (await upload(env.ctx, "gl-policy.pdf", pdf("gl"), { category: "Insurance", docType: "insurance policy", tags: "general liability", expirationDate: await day(10) })).data.document;
    const expired = (await upload(env.ctx, "old-lease.txt", Buffer.from("lease"), { category: "Contracts", docType: "lease", expirationDate: await day(-5) })).data.document;
    const ids = async (qs: string) => (await call(tool, env.ctx, "GET", `documents?${qs}`)).data.documents.map((d: { id: string }) => d.id).sort();
    expect(await ids("q=liability")).toEqual([insurance.id]); // tag
    expect(await ids("q=insurance")).toEqual([insurance.id]); // doc type and category
    expect(await ids("q=old-lease")).toEqual([expired.id]); // filename
    expect(await ids("q=operating")).toEqual([docId]); // name
    expect(await ids("category=Contracts")).toEqual([expired.id]);
    expect(await ids("expiring=1")).toEqual([insurance.id, expired.id].sort());
    expect(await ids("tag=general liability")).toEqual([insurance.id]);
    expect(await ids("q=%25")).toEqual([]); // wildcard characters are not treated as patterns
    expect((await call(tool, env.ctx, "GET", "documents?category=Bogus")).status).toBe(400);
    expect((await call(tool, env.ctx, "GET", "documents?status=bogus")).status).toBe(400);
  });

  it("isolates businesses, including blob downloads", async () => {
    expect((await call(tool, env.other, "GET", "documents")).data.documents).toEqual([]);
    expect((await call(tool, env.other, "GET", `documents/${docId}`)).status).toBe(404);
    expect((await download(env.other, docId)).status).toBe(404);
    expect((await download(env.other, docId, 1)).status).toBe(404);
    expect((await call(tool, env.other, "PATCH", `documents/${docId}`, { name: "hacked" })).status).toBe(404);
    expect((await call(tool, env.other, "DELETE", `documents/${docId}`)).status).toBe(404);
    expect((await upload(env.other, "x.pdf", pdf(), {}, `documents/${docId}/versions`)).status).toBe(404);
    expect(await tool.resolve!(env.other, docId)).toBeNull();
    expect(await tool.search!(env.other, "operating", 5)).toEqual([]);
    expect(await tool.attention!(env.other)).toEqual([]);
    expect(await tool.describe!(env.other)).toBe("");
    expect(await tool.facts!(env.other)).toMatchObject({ documentCount: 0, categories: [], docTypes: [], expiringSoon: 0, hasOperatingAgreement: false });
    // Still intact for the owner after the failed attacks.
    expect((await call(tool, env.ctx, "GET", `documents/${docId}`)).data.document).toMatchObject({ version: 2, name: "Operating Agreement (signed)" });
    await expect(env.other.links.add({ tool: "vault", id: docId }, { tool: "vault", id: docId })).rejects.toThrow();
  });

  it("viewers can read and download but not change", async () => {
    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      expect((await upload(viewer.ctx, "a.pdf", pdf())).status).toBe(403);
      expect((await call(tool, viewer.ctx, "GET", "documents")).status).toBe(200);
      const mine = (await upload(env.ctx, "viewer-test.pdf", pdf("v"))).data.document.id;
      expect((await call(tool, viewer.ctx, "PATCH", `documents/${mine}`, { name: "x" })).status).toBe(403);
      expect((await call(tool, viewer.ctx, "DELETE", `documents/${mine}`)).status).toBe(403);
      expect((await upload(viewer.ctx, "a.pdf", pdf(), {}, `documents/${mine}/versions`)).status).toBe(403);
      // Same-business viewer can download; a viewer in another business cannot.
      const own = await upload(viewer.ctx, "z.pdf", pdf(), {});
      expect(own.status).toBe(403);
      expect((await download(viewer.ctx, mine)).status).toBe(404);
    } finally {
      await viewer.cleanup();
    }
  });

  it("publishes facts, describe, attention, resolve and search; links work", async () => {
    const f = (await tool.facts!(env.ctx)) as Record<string, unknown>;
    expect(f).toMatchObject({ hasOperatingAgreement: true, hasInsurance: true, hasPrivacyPolicy: false, hasContractorAgreement: false, hasFormationDocs: true, expired: 1 });
    expect(f.categories).toEqual(expect.arrayContaining(["legal", "insurance", "contracts"]));
    expect(f.docTypes).toEqual(expect.arrayContaining(["operating agreement", "insurance policy", "lease"]));
    expect(f.documentCount).toBe(4);
    expect(f.expiringSoon).toBe(2); // insurance in 10 days + the expired lease

    const d = await tool.describe!(env.ctx);
    expect(d).toMatch(/4 documents/);
    expect(d).toMatch(/Not found by name or type: .*privacy policy/);
    expect(d).toMatch(/2 expiring within 60 days \(1 already expired\)/);
    expect(d.length).toBeLessThanOrEqual(600);

    const att = await tool.attention!(env.ctx);
    expect(att.map((a) => a.severity)).toEqual(["high", "review"]);
    expect(att[0]).toMatchObject({ title: "old-lease has expired", dueDate: await day(-5) });
    expect(att[1].title).toMatch(/gl-policy expires soon/);
    expect(att[1].href).toMatch(/^\/app\/t\/vault\/d\//);

    expect(await tool.resolve!(env.ctx, docId)).toEqual({ title: "Operating Agreement (signed)", href: `/app/t/vault/d/${docId}` });
    expect(await tool.resolve!(env.ctx, "garbage")).toBeNull();
    const hits = await tool.search!(env.ctx, "operating", 5);
    expect(hits[0]).toMatchObject({ id: docId, title: "Operating Agreement (signed)", snippet: "Legal · Operating Agreement" });
    expect((await env.ctx.search("lease")).some((g) => g.tool === "vault")).toBe(true);

    await env.ctx.links.add({ tool: "vault", id: docId }, { tool: "vault", id: hits[0].id }, "self");
    expect((await env.ctx.links.list({ tool: "vault", id: docId }))[0]).toMatchObject({ tool: "vault", title: "Operating Agreement (signed)" });
    expect((await env.ctx.context()).summaries.vault).toMatch(/documents on file/);
  });

  it("archived and draft documents do not count as having a key document", async () => {
    const e2 = await makeTestEnv([tool]);
    try {
      const a = (await upload(e2.ctx, "pp.pdf", pdf(), { docType: "Privacy Policy", status: "draft" })).data.document;
      expect(await tool.facts!(e2.ctx)).toMatchObject({ documentCount: 1, hasPrivacyPolicy: false });
      await call(tool, e2.ctx, "PATCH", `documents/${a.id}`, { status: "active" });
      expect(await tool.facts!(e2.ctx)).toMatchObject({ hasPrivacyPolicy: true });
      await call(tool, e2.ctx, "PATCH", `documents/${a.id}`, { status: "archived", expirationDate: await day(-1) });
      expect(await tool.facts!(e2.ctx)).toMatchObject({ documentCount: 0, hasPrivacyPolicy: false, expired: 0 });
      expect(await tool.attention!(e2.ctx)).toEqual([]);
    } finally {
      await e2.cleanup();
    }
  });

  it("deletes a document with all of its versions and file contents", async () => {
    const [{ n: before }] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_blobs WHERE document_id = ${docId}`;
    expect(before).toBe(2);
    expect((await call(tool, env.ctx, "DELETE", `documents/${docId}`)).status).toBe(200);
    const [{ n }] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_blobs WHERE document_id = ${docId}`;
    expect(n).toBe(0);
    expect((await download(env.ctx, docId)).status).toBe(404);
    expect((await call(tool, env.ctx, "DELETE", `documents/${docId}`)).status).toBe(404);
  });
});
