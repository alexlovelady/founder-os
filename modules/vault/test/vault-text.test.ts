import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@founderos/sdk";
import { call, FakeAi, makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { tool } from "../src/index";
import { SUMMARY_INPUT_CHARS } from "../src/text";
import { bombDocx, docx, textPdf, xlsx } from "./fixtures";

async function upload(ctx: ToolContext, filename: string, bytes: Buffer, fields: Record<string, string> = {}, path = "documents") {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], filename));
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  const res = await tool.api!(ctx, new Request(`http://test/api/tools/vault/${path}`, { method: "POST", body: fd }), path.split("/"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}

const NDA = "MUTUAL NON-DISCLOSURE AGREEMENT\nThis agreement is between Acme Corp (Disclosing Party) and Sunrise Plumbing LLC (Receiving Party). Either party may terminate this agreement on thirty days notice. Termination does not end confidentiality duties.";

describe("vault text extraction, search, classification and summaries (database)", () => {
  let env: TestEnv;
  const ai = new FakeAi(["A mutual NDA between Acme and Sunrise."]);
  beforeAll(async () => {
    env = await makeTestEnv([tool], { ai });
  });
  afterAll(async () => {
    await env.cleanup();
  });

  const textOf = async (id: string) => (await call(tool, env.ctx, "GET", `documents/${id}/text`)).data;

  it("extracts text on upload for each supported type", async () => {
    const cases: [string, Buffer, string][] = [
      ["notes.txt", Buffer.from("Plain notes about the lease renewal."), "lease renewal"],
      ["readme.md", Buffer.from("# Heading\n\nMarkdown body about payroll."), "payroll"],
      ["rows.csv", Buffer.from("vendor,amount\nAcme Supply,100\n"), "Acme Supply"],
      ["contract.docx", docx(["SERVICES AGREEMENT", "The vendor delivers monthly reports."]), "monthly reports"],
      ["costs.xlsx", xlsx([["Item", "Cost"], ["Truck lease", 700]]), "Truck lease"],
      ["nda.pdf", textPdf([[...NDA.split("\n")]]), "NON-DISCLOSURE"],
    ];
    for (const [name, bytes, needle] of cases) {
      const r = await upload(env.ctx, name, bytes);
      expect(r.status, name).toBe(201);
      expect(r.data.extraction.status, name).toBe("ready");
      expect((await textOf(r.data.document.id)).text, name).toContain(needle);
      expect(r.data.document.textStatus).toBe("ready");
    }
  });

  it("never fails an upload because extraction failed, and says why", async () => {
    // Passes the vault's upload checks but is not a readable PDF / docx.
    const badPdf = await upload(env.ctx, "broken.pdf", Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF"));
    expect(badPdf.status).toBe(201);
    expect(badPdf.data.extraction.status).toBe("failed");
    expect(badPdf.data.extraction.error).toBeTruthy();
    const badDocx = await upload(env.ctx, "broken.docx", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("\0\0[Content_Types].xml\0word/\0")]));
    expect(badDocx.status).toBe(201);
    expect(badDocx.data.extraction.status).toBe("failed");
    // The file itself is intact and downloadable.
    const dl = await tool.api!(env.ctx, new Request("http://t/x"), ["documents", badPdf.data.document.id, "download"]);
    expect(dl.status).toBe(200);
  });

  it("refuses to unpack a zip bomb but still stores the file", async () => {
    const r = await upload(env.ctx, "bomb.docx", bombDocx(60));
    expect(r.status).toBe(201);
    expect(r.data.extraction).toMatchObject({ status: "failed" });
    expect(r.data.extraction.error).toMatch(/too large once unpacked/);
  });

  it("flags a scanned PDF and images as needing OCR in LegalAI", async () => {
    const scan = await upload(env.ctx, "scan.pdf", textPdf([[], []]));
    expect(scan.data.extraction).toMatchObject({ status: "unsupported", needsOcr: true });
    expect(scan.data.extraction.error).toBe("scanned image (send it to LegalAI, which runs OCR)");
    const img = await upload(env.ctx, "photo.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]));
    expect(img.data.extraction.status).toBe("unsupported");
    expect((await textOf(scan.data.document.id)).text).toBe("");
  });

  let ndaId: string;
  it("searches inside files with ranking and escaped, highlighted snippets", async () => {
    const hostile = await upload(env.ctx, "terms.txt", Buffer.from('You may terminate <script>alert("x")</script> <img src=x onerror=alert(1)> at any time.'));
    ndaId = (await upload(env.ctx, "acme-nda.pdf", textPdf([[...NDA.split("\n")]]), { category: "Contracts" })).data.document.id;
    const res = await call(tool, env.ctx, "GET", "documents?q=termination");
    const docs = res.data.documents as { id: string; name: string; snippet?: string }[];
    const ids = docs.map((d) => d.id);
    expect(ids).toContain(hostile.data.document.id);
    expect(ids).toContain(ndaId);
    for (const d of docs) {
      expect(d.snippet).toBeTruthy();
      expect(d.snippet).toMatch(/<mark>/);
      // The only HTML in a snippet is our own <mark>; everything from the file is escaped.
      expect(d.snippet!.replace(/<\/?mark>/g, "")).not.toMatch(/[<>]/);
    }
    const h = docs.find((d) => d.id === hostile.data.document.id)!;
    expect(h.snippet).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(h.snippet).not.toMatch(/<(script|img)/);
    // Stemming: "terminate" finds the same files.
    expect((await call(tool, env.ctx, "GET", "documents?q=terminate")).data.documents.length).toBeGreaterThanOrEqual(2);
    // Metadata search still works, with no snippet when the text did not match.
    const meta = (await call(tool, env.ctx, "GET", "documents?q=acme-nda")).data.documents as { id: string }[];
    expect(meta.map((d) => d.id)).toEqual([ndaId]);
    expect((await call(tool, env.ctx, "GET", "documents?q=zzzzqqqq")).data.documents).toEqual([]);
    // A name match outranks a body-only match.
    const ranked = (await call(tool, env.ctx, "GET", "documents?q=notes")).data.documents as { name: string }[];
    expect(ranked[0].name).toBe("notes");
  });

  it("feeds global search and facts", async () => {
    const hits = await tool.search!(env.ctx, "thirty days notice", 5);
    expect(hits.map((h) => h.id)).toContain(ndaId);
    expect(hits.find((h) => h.id === ndaId)!.snippet).not.toMatch(/<mark>|&lt;/);
    const f = (await tool.facts!(env.ctx)) as { documentsWithText: number; documentCount: number };
    expect(f.documentsWithText).toBeGreaterThanOrEqual(8);
    expect(f.documentsWithText).toBeLessThan(f.documentCount);
  });

  it("keeps vault_text and search tenant-isolated", async () => {
    expect((await textOf(ndaId)).status).toBe("ready");
    expect((await call(tool, env.other, "GET", `documents/${ndaId}/text`)).status).toBe(404);
    expect((await call(tool, env.other, "GET", "documents?q=termination")).data.documents).toEqual([]);
    expect(await tool.search!(env.other, "thirty days notice", 5)).toEqual([]);
    expect(await tool.facts!(env.other)).toMatchObject({ documentsWithText: 0 });
    expect((await call(tool, env.other, "POST", `documents/${ndaId}/extract`)).status).toBe(404);
    expect((await call(tool, env.other, "POST", `documents/${ndaId}/summary`)).status).toBe(404);
    expect((await call(tool, env.other, "GET", `documents/${ndaId}/summary`)).status).toBe(404);
    expect((await call(tool, env.other, "POST", `documents/${ndaId}/legal-link`, { legalDocumentId: "00000000-0000-4000-8000-000000000000", perspective: "neutral", version: 1 })).status).toBe(404);
    const rows = await env.sql`SELECT business_id FROM vault_text WHERE document_id = ${ndaId}`;
    expect(rows.map((r) => r.business_id)).toEqual([env.ctx.businessId]);
  });

  it("suggests a classification, never applies it, and accepting is one PATCH", async () => {
    const d = (await call(tool, env.ctx, "GET", `documents/${ndaId}`)).data;
    expect(d.document.docType).toBe("");
    expect(d.suggestion).toMatchObject({ docType: "NDA", category: "Contracts" });
    expect(d.suggestion.evidence.length).toBeGreaterThan(0);
    // Category was set at upload, docType is not: so accepting changes the type and the suggestion goes away.
    const p = await call(tool, env.ctx, "PATCH", `documents/${ndaId}`, { category: d.suggestion.category, docType: d.suggestion.docType });
    expect(p.data.document).toMatchObject({ category: "Contracts", docType: "NDA" });
    expect((await call(tool, env.ctx, "GET", `documents/${ndaId}`)).data.suggestion).toBeNull();
  });

  it("replaces the text with a new version and supports Re-extract", async () => {
    const r = await upload(env.ctx, "acme-nda-v2.docx", docx(["MUTUAL NON-DISCLOSURE AGREEMENT", "Second version adds an arbitration clause."]), {}, `documents/${ndaId}/versions`);
    expect(r.status).toBe(201);
    expect(r.data.extraction.status).toBe("ready");
    expect((await textOf(ndaId)).text).toContain("arbitration");
    const old = (await call(tool, env.ctx, "GET", "documents?q=thirty")).data.documents as { id: string }[];
    expect(old.map((d) => d.id)).not.toContain(ndaId); // the old version's text is no longer searched
    expect(((await call(tool, env.ctx, "GET", "documents?q=arbitration")).data.documents as { id: string }[]).map((d) => d.id)).toEqual([ndaId]);
    const rows = await env.sql`SELECT version FROM vault_text WHERE document_id = ${ndaId}`;
    expect(rows.map((x) => x.version)).toEqual([2]);
    await env.sql`UPDATE vault_text SET status = 'failed', text = '', error = 'x' WHERE document_id = ${ndaId}`;
    const re = await call(tool, env.ctx, "POST", `documents/${ndaId}/extract`);
    expect(re.status).toBe(200);
    expect(re.data.extraction.status).toBe("ready");
    expect((await textOf(ndaId)).text).toContain("arbitration");
  });

  it("viewers cannot re-extract, summarize or record links", async () => {
    const viewer = await makeTestEnv([tool], { role: "viewer" });
    try {
      const mine = (await upload(viewer.other, "v.txt", Buffer.from("viewer owned text"))).data.document.id;
      expect((await call(tool, viewer.ctx, "POST", `documents/${mine}/extract`)).status).toBe(403);
      expect((await call(tool, viewer.ctx, "POST", `documents/${mine}/summary`)).status).toBe(403);
      expect((await call(tool, viewer.ctx, "POST", `documents/${mine}/legal-link`, { legalDocumentId: "00000000-0000-4000-8000-000000000000", perspective: "neutral", version: 1 })).status).toBe(403);
    } finally {
      await viewer.cleanup();
    }
  });

  describe("AI summary", () => {
    it("starts a job grounded in the business context and the first 6000 characters, then stores the result", async () => {
      const long = "Clause about deliveries. ".repeat(600); // 15,000 characters
      const id = (await upload(env.ctx, "long.txt", Buffer.from(`SECTION ONE\n${long}END-MARKER`))).data.document.id;
      const quota = vi.fn(async () => {});
      env.ctx.useQuota = quota;
      const start = await call(tool, env.ctx, "POST", `documents/${id}/summary`);
      expect(start.status).toBe(202);
      expect(start.data).toMatchObject({ state: "running", truncated: true });
      expect(quota).toHaveBeenCalledWith("aiRequestsPerMonth");
      const sent = ai.calls.at(-1)!;
      expect(sent.prompt).toContain("Test Co A"); // business context
      expect(sent.prompt).toContain("SECTION ONE");
      expect(sent.prompt).not.toContain("END-MARKER"); // beyond the first 6000 characters
      expect(sent.prompt).toContain(`first ${SUMMARY_INPUT_CHARS} characters`);
      expect(sent.system).toMatch(/untrusted/);
      const detailMid = (await call(tool, env.ctx, "GET", `documents/${id}`)).data;
      expect(detailMid.summaryPending).toBe(true);
      const polled = await call(tool, env.ctx, "GET", `documents/${id}/summary`);
      expect(polled.data.state).toBe("done");
      expect(polled.data.summary).toMatchObject({ text: "A mutual NDA between Acme and Sunrise.", truncated: true, label: "AI summary, check against the document", version: 1 });
      expect(polled.data.summary.createdAt).toBeTruthy();
      const idle = (await call(tool, env.ctx, "GET", `documents/${id}/summary`)).data;
      expect(idle.state).toBe("idle");
      expect(idle.summary.text).toContain("mutual NDA");
      expect((await call(tool, env.ctx, "GET", `documents/${id}`)).data.summary.label).toBe("AI summary, check against the document");
    });

    it("does not call the AI when it is unavailable, there is no text, or the quota is spent", async () => {
      const id = (await upload(env.ctx, "short.txt", Buffer.from("A short note."))).data.document.id;
      const calls = ai.calls.length;
      ai.available = false;
      const off = await call(tool, env.ctx, "POST", `documents/${id}/summary`);
      expect(off.status).toBe(503);
      expect(off.data.error).toMatch(/AI is not set up/);
      ai.available = true;
      const scan = (await upload(env.ctx, "s.pdf", textPdf([[]]))).data.document.id;
      expect((await call(tool, env.ctx, "POST", `documents/${scan}/summary`)).status).toBe(409);
      env.ctx.useQuota = async () => { const { HttpError } = await import("@founderos/sdk"); throw new HttpError(402, "You have used all of this month's AI requests."); };
      const spent = await call(tool, env.ctx, "POST", `documents/${id}/summary`);
      expect(spent.status).toBe(402);
      expect(ai.calls.length).toBe(calls);
      env.ctx.useQuota = async () => {};
      const ok = await call(tool, env.ctx, "POST", `documents/${id}/summary`);
      expect(ok.data.truncated).toBe(false);
    });

    it("reports a failed job without keeping it pending", async () => {
      const id = (await upload(env.ctx, "fail.txt", Buffer.from("Some content to summarize."))).data.document.id;
      const orig = ai.poll.bind(ai);
      ai.poll = async () => ({ state: "failed", error: "The model is overloaded" });
      await call(tool, env.ctx, "POST", `documents/${id}/summary`);
      const r = await call(tool, env.ctx, "GET", `documents/${id}/summary`);
      expect(r.data).toMatchObject({ state: "failed", error: "The model is overloaded" });
      expect((await call(tool, env.ctx, "GET", `documents/${id}`)).data.summaryPending).toBe(false);
      ai.poll = orig;
    });
  });

  it("records LegalAI links and rejects bad ones", async () => {
    const link = { legalDocumentId: "11111111-1111-4111-8111-111111111111", legalReviewId: "22222222-2222-4222-8222-222222222222", perspective: "vendor", version: 2 };
    expect((await call(tool, env.ctx, "POST", `documents/${ndaId}/legal-link`, link)).status).toBe(201);
    expect((await call(tool, env.ctx, "GET", `documents/${ndaId}`)).data.legalLink).toMatchObject({ legalDocumentId: link.legalDocumentId, legalReviewId: link.legalReviewId, perspective: "vendor", version: 2 });
    expect((await call(tool, env.ctx, "POST", `documents/${ndaId}/legal-link`, { ...link, legalDocumentId: "nope" })).status).toBe(400);
    expect((await call(tool, env.ctx, "POST", `documents/${ndaId}/legal-link`, { ...link, perspective: "hacker" })).status).toBe(400);
    expect((await call(tool, env.other, "GET", `documents/${ndaId}`)).status).toBe(404);
  });
});
