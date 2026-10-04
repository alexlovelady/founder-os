import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { ToolContext } from "@founderos/sdk";
import { makeTestEnv, type TestEnv } from "@founderos/sdk/testing";
import { clamdScan, scanUpload, scanUploadFull } from "../src/scan";
import { legalReviewUrl } from "../src/legallink";
import { tool } from "../src/index";
import { textPdf } from "./fixtures";

const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const rels = (...items: string[]) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join("")}</Relationships>`;
const rel = (type: string, target: string, external = true) => `<Relationship Id="r${Math.random().toString(36).slice(2, 6)}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target.replace(/&/g, "&amp;")}"${external ? ' TargetMode="External"' : ""}/>`;
const body = (inner = "<w:p><w:r><w:t>Hello</w:t></w:r></w:p>") => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${inner}</w:body></w:document>`;
function docx(extra: Record<string, string> = {}, ct = CT, doc = body()): Buffer {
  const files: Record<string, Uint8Array> = { "[Content_Types].xml": strToU8(ct), "word/document.xml": strToU8(doc) };
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  return Buffer.from(zipSync(files));
}
const scan = (name: string, b: Uint8Array) => scanUpload(name, b, name.slice(name.lastIndexOf(".") + 1));
const blockedFor = (r: ReturnType<typeof scanUpload>, re: RegExp) => r.verdict === "blocked" && r.findings.some((f) => re.test(f));

describe("scanner: clean files pass", () => {
  it("a normal docx with hyperlinks", () => {
    const d = docx({ "word/_rels/document.xml.rels": rels(rel("hyperlink", "https://example.com/a?x=1&y=2"), rel("hyperlink", "mailto:me@example.com"), rel("hyperlink", "http://example.com/plain"), rel("styles", "styles.xml", false)) });
    expect(scan("a.docx", d)).toEqual({ verdict: "clean", findings: [] });
  });
  it("a normal pdf", () => expect(scan("a.pdf", textPdf([["Hello", "world"]]))).toEqual({ verdict: "clean", findings: [] }));
  it("plain text, csv, markdown (even one that mentions a script tag)", () => {
    expect(scan("a.txt", Buffer.from("Hello there.\nYou may terminate <script>x</script> any time.")).verdict).toBe("clean");
    expect(scan("a.csv", Buffer.from("a,b\n1,2\n")).verdict).toBe("clean");
    expect(scan("a.md", Buffer.from("# Title\n\nSome text")).verdict).toBe("clean");
  });
  it("images with nothing after the end marker", () => {
    expect(scan("a.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9])).verdict).toBe("clean");
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
    expect(scan("a.png", png).verdict).toBe("clean");
  });
  it("a legacy doc (OLE) and an rtf without objects", () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from("WordDocument", "utf16le")]);
    expect(scan("a.doc", ole).verdict).toBe("clean");
    expect(scan("a.doc", Buffer.from("{\\rtf1\\ansi Hello}")).verdict).toBe("clean");
  });
});

describe("scanner: blocks active content", () => {
  it("office macros, ActiveX, OLE objects", () => {
    expect(blockedFor(scan("a.docx", docx({ "word/vbaProject.bin": "x" })), /VBA macro/)).toBe(true);
    expect(blockedFor(scan("a.docx", docx({}, CT.replace("</Types>", '<Override PartName="/word/document.xml" ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>'))), /macro-enabled/)).toBe(true);
    expect(blockedFor(scan("a.docx", docx({ "word/activeX/activeX1.xml": "x" })), /ActiveX/)).toBe(true);
    expect(blockedFor(scan("a.docx", docx({ "word/embeddings/oleObject1.bin": "x" })), /OLE/)).toBe(true);
    expect(blockedFor(scan("a.xlsx", docx({ "xl/macrosheets/sheet1.xml": "x" })), /macro sheets/)).toBe(true);
    expect(blockedFor(scan("a.docx", docx({ "word/payload.exe": "MZ" })), /executable or script/)).toBe(true);
  });
  it("external relationship targets that are not https or are executables", () => {
    const r = (type: string, target: string) => scan("a.docx", docx({ "word/_rels/document.xml.rels": rels(rel(type, target)) }));
    expect(blockedFor(r("oleObject", "http://evil.example/x"), /does not use https/)).toBe(true);
    expect(blockedFor(r("attachedTemplate", "file:///C:/evil.dotm"), /script or local-file/)).toBe(true);
    expect(blockedFor(r("hyperlink", "https://evil.example/setup.exe"), /executable or script/)).toBe(true);
    expect(blockedFor(r("hyperlink", "javascript:alert(1)"), /script or local-file/)).toBe(true);
    expect(r("image", "https://cdn.example/logo.png").verdict).toBe("clean");
    expect(blockedFor(r("image", "http://cdn.example/logo.png"), /does not use https/)).toBe(true);
  });
  it("DDE fields, split across runs too", () => {
    const dde = body('<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>DDEAUTO c:\\\\windows\\\\system32\\\\cmd.exe "/k calc"</w:instrText></w:r>');
    expect(blockedFor(scan("a.docx", docx({}, CT, dde)), /DDE/)).toBe(true);
    const split = body("<w:r><w:instrText>DD</w:instrText></w:r><w:r><w:instrText>E cmd</w:instrText></w:r>");
    expect(blockedFor(scan("a.docx", docx({}, CT, split)), /DDE/)).toBe(true);
    expect(blockedFor(scan("a.xlsx", docx({ "xl/externalLinks/externalLink1.xml": '<externalLink><ddeLink ddeService="cmd" ddeTopic="/c calc"/></externalLink>' })), /DDE/)).toBe(true);
  });
  it("legacy doc macros and rtf objects", () => {
    const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from("_VBA_PROJECT", "utf16le")]);
    expect(blockedFor(scan("a.doc", ole), /VBA/)).toBe(true);
    expect(blockedFor(scan("a.doc", Buffer.from("{\\rtf1{\\object\\objemb{\\*\\objdata 0105}}}")), /OLE/)).toBe(true);
  });
  it("pdf JavaScript, Launch, OpenAction JavaScript, embedded files, obfuscated names", () => {
    const pdf = (extra: string) => Buffer.from(`%PDF-1.4\n1 0 obj<< /Type /Catalog ${extra} >>endobj\n%%EOF`);
    expect(blockedFor(scan("a.pdf", pdf("/OpenAction << /S /JavaScript /JS (app.alert(1)) >>")), /JavaScript/)).toBe(true);
    expect(blockedFor(scan("a.pdf", pdf("/AA << /JS (x) >>")), /JavaScript/)).toBe(true);
    expect(blockedFor(scan("a.pdf", pdf("/OpenAction << /S /Launch /F (cmd.exe) >>")), /Launch/)).toBe(true);
    expect(blockedFor(scan("a.pdf", pdf("/Names << /EmbeddedFiles 2 0 R >> /Type /EmbeddedFile")), /embedded file/)).toBe(true);
    expect(blockedFor(scan("a.pdf", pdf("/S /J#61vaScript")), /JavaScript/)).toBe(true);
  });
  it("html and svg disguised as other types", () => {
    expect(blockedFor(scan("a.txt", Buffer.from("<!DOCTYPE html><html><script>x</script>")), /HTML or SVG/)).toBe(true);
    expect(blockedFor(scan("a.md", Buffer.from('  <svg onload="alert(1)"></svg>')), /HTML or SVG/)).toBe(true);
    expect(blockedFor(scan("a.csv", Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')), /HTML or SVG/)).toBe(true);
  });
  it("binary or script content in text files", () => {
    expect(blockedFor(scan("a.txt", Buffer.from("#!/bin/sh\nrm -rf /")), /script/)).toBe(true);
    expect(blockedFor(scan("a.txt", Buffer.from(Array.from({ length: 400 }, (_, i) => (i % 3 === 0 ? 1 : 65)))), /binary/)).toBe(true);
    expect(blockedFor(scan("a.txt", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), /archive/)).toBe(true);
  });
  it("payloads appended to images", () => {
    const zipTail = Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]);
    expect(blockedFor(scan("a.jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]), zipTail])), /zip archive/)).toBe(true);
    expect(blockedFor(scan("a.jpeg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 0xff, 0xd9]), Buffer.from("MZ\x90\0This program cannot be run in DOS mode", "latin1")])), /executable/)).toBe(true);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
    expect(blockedFor(scan("a.png", Buffer.concat([png, zipTail])), /zip archive/)).toBe(true);
    expect(blockedFor(scan("a.png", Buffer.concat([png, Buffer.from("Rar!\x1a\x07", "latin1")])), /RAR/)).toBe(true);
  });
  it("the EICAR test string", () => {
    const eicar = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
    expect(blockedFor(scan("a.txt", Buffer.from(eicar)), /antivirus test/)).toBe(true);
  });
});

/** A fake clamd: reads the INSTREAM framing and answers with `reply`. */
function fakeClamd(reply: string | null): Promise<{ server: Server; port: number; received: () => { command: string; bytes: number } }> {
  let command = "";
  let bytes = 0;
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let started = false;
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        const z = buf.indexOf(0);
        if (z < 0) return;
        command = buf.subarray(0, z).toString();
        buf = buf.subarray(z + 1);
        started = true;
      }
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0) {
          if (reply !== null) sock.end(reply);
          return; // reply === null: never answer, to exercise the timeout
        }
        if (buf.length < 4 + n) return;
        bytes += n;
        buf = buf.subarray(4 + n);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, received: () => ({ command, bytes }) })));
}

describe("ClamAV (clamd INSTREAM)", () => {
  const data = Buffer.alloc(150_000, 65);
  it("streams the file and reports clean", async () => {
    const f = await fakeClamd("stream: OK\0");
    const r = await clamdScan(data, { host: "127.0.0.1", port: f.port });
    f.server.close();
    expect(r).toEqual({ infected: false });
    expect(f.received()).toEqual({ command: "zINSTREAM", bytes: 150_000 });
  });
  it("blocks when clamd finds something", async () => {
    const f = await fakeClamd("stream: Win.Test.EICAR_HDB-1 FOUND\0");
    const r = await scanUploadFull("a.txt", Buffer.from("hello"), "txt", { CLAMD_HOST: "127.0.0.1", CLAMD_PORT: String(f.port) });
    f.server.close();
    expect(r.verdict).toBe("blocked");
    expect(r.findings[0]).toContain("Win.Test.EICAR_HDB-1");
  });
  it("fails open with a warning when unreachable", async () => {
    const f = await fakeClamd("stream: OK\0");
    const port = f.port;
    await new Promise((r) => f.server.close(r));
    const warn = vi.fn();
    expect(await clamdScan(data, { host: "127.0.0.1", port, warn })).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    const r = await scanUploadFull("a.txt", Buffer.from("hello"), "txt", { CLAMD_HOST: "127.0.0.1", CLAMD_PORT: String(port) });
    expect(r.verdict).toBe("clean");
  });
  it("times out and fails open when clamd never answers", async () => {
    const f = await fakeClamd(null);
    const warn = vi.fn();
    expect(await clamdScan(data, { host: "127.0.0.1", port: f.port, timeoutMs: 300, warn })).toBeNull();
    f.server.close();
    expect(warn.mock.calls[0][0]).toContain("timed out");
  });
  it("is not contacted when CLAMD_HOST is unset", async () => {
    expect((await scanUploadFull("a.txt", Buffer.from("hello"), "txt", {})).verdict).toBe("clean");
  });
});

describe("LegalAI review URL", () => {
  const ws = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const rv = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  it("builds the contracts route with the review", () => {
    expect(legalReviewUrl(ws, rv)).toBe(`/legal-ui/matters/${ws}/contracts?review=${rv}`);
    expect(legalReviewUrl(ws, null)).toBe(`/legal-ui/matters/${ws}/contracts`);
  });
  it("falls back to LegalAI home and never puts odd values in the URL", () => {
    expect(legalReviewUrl(undefined, rv)).toBe("/legal-ui/");
    expect(legalReviewUrl("../x?y", rv)).toBe("/legal-ui/");
    expect(legalReviewUrl(ws, "x&y=<script>")).toBe(`/legal-ui/matters/${ws}/contracts`);
  });
});

describe("upload integration", () => {
  let env: TestEnv;
  const audits: { action: string; meta?: Record<string, unknown> }[] = [];
  let ctx: ToolContext;
  beforeAll(async () => {
    env = await makeTestEnv([tool]);
    ctx = { ...env.ctx, audit: async (action, meta) => void audits.push({ action, meta }) };
  });
  afterAll(async () => env.cleanup());
  const post = async (path: string, name: string, bytes: Buffer) => {
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(bytes)], name));
    const res = await tool.api!(ctx, new Request(`http://test/api/tools/vault/${path}`, { method: "POST", body: fd }), path.split("/"));
    return { status: res.status, data: (await res.json().catch(() => null)) as { error?: string; document?: { id: string } } | null };
  };

  it("refuses a macro docx on upload and as a new version, audits without contents, stores nothing", async () => {
    const bad = docx({ "word/vbaProject.bin": "SECRET-CONTENT" });
    const r = await post("documents", "evil.docx", bad);
    expect(r.status).toBe(422);
    expect(r.data?.error).toMatch(/not stored.*VBA macro/);
    const a = audits.find((x) => x.action === "vault.upload_blocked");
    expect(a?.meta).toMatchObject({ filename: "evil.docx" });
    expect(JSON.stringify(a)).not.toContain("SECRET-CONTENT");
    const [n] = await env.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM vault_documents WHERE business_id = ${env.ctx.businessId}`;
    expect(n.n).toBe(0);

    const ok = await post("documents", "fine.docx", docx());
    expect(ok.status).toBe(201);
    const id = (ok.data as { document?: { id: string }; id?: string }).document?.id ?? (ok.data as { id?: string }).id;
    const v = await post(`documents/${id}/versions`, "evil2.docx", bad);
    expect(v.status).toBe(422);
  });
});
