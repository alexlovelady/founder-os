import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { extractText, MAX_TEXT_CHARS, MAX_ZIP_ENTRIES, SCANNED_MESSAGE } from "../src/extract";
import { safeSnippet, escapeHtml } from "../src/text";
import { bombDocx, docx, textPdf, xlsx } from "./fixtures";

describe("text extraction", () => {
  it("reads txt, md and csv (including a BOM and UTF-16)", async () => {
    expect((await extractText("txt", Buffer.from("Hello\r\nworld"))).text).toBe("Hello\nworld");
    expect((await extractText("md", Buffer.from("﻿# Title\n\nBody"))).text).toBe("# Title\n\nBody");
    const csv = await extractText("csv", Buffer.from("name,amount\nAcme,100\n"));
    expect(csv).toMatchObject({ status: "ready", pageCount: null, error: null });
    expect(csv.text).toContain("Acme,100");
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Wide text", "utf16le")]);
    expect((await extractText("txt", utf16)).text).toBe("Wide text");
  });

  it("strips control characters and caps the stored text", async () => {
    const r = await extractText("txt", Buffer.from("a\u0001b\u0007c"));
    expect(r.text).toBe("a b c");
    const big = await extractText("txt", Buffer.from("word ".repeat(1_000_000)));
    expect(big.status).toBe("ready");
    expect(big.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });

  it("reads a docx, decoding entities and keeping paragraph breaks", async () => {
    const r = await extractText("docx", docx(["OPERATING AGREEMENT", "Smith & Jones <LLC>", "Second paragraph"]));
    expect(r.status).toBe("ready");
    expect(r.text).toBe("OPERATING AGREEMENT\nSmith & Jones <LLC>\nSecond paragraph");
  });

  it("reads an xlsx from shared strings and numbers", async () => {
    const r = await extractText("xlsx", xlsx([["Vendor", "Amount"], ["Acme Supply", 1250.5]]));
    expect(r.status).toBe("ready");
    expect(r.text).toBe("Vendor Amount\nAcme Supply 1250.5"); // cells are tab separated; whitespace is normalised on the way in
  });

  it("reads a PDF with a text layer and counts pages", async () => {
    const r = await extractText("pdf", textPdf([["MUTUAL NON-DISCLOSURE AGREEMENT", "This Agreement is made between Acme and Beta."], ["Page two: governing law is North Carolina."]]));
    expect(r.status).toBe("ready");
    expect(r.pageCount).toBe(2);
    expect(r.text).toContain("MUTUAL NON-DISCLOSURE AGREEMENT");
    expect(r.text).toContain("governing law is North Carolina");
  });

  it("marks a PDF with no text layer as a scan to send to LegalAI", async () => {
    const r = await extractText("pdf", textPdf([[], []]));
    expect(r).toMatchObject({ status: "unsupported", error: SCANNED_MESSAGE, text: "" });
    expect((await extractText("png", Buffer.from("x"))).status).toBe("unsupported");
    expect((await extractText("doc", Buffer.from("x"))).status).toBe("unsupported");
  });

  it("fails cleanly, without throwing, on damaged files", async () => {
    expect(await extractText("pdf", Buffer.from("%PDF-1.4 garbage"))).toMatchObject({ status: "failed", text: "" });
    expect(await extractText("docx", Buffer.from("PK\u0003\u0004 not really a zip"))).toMatchObject({ status: "failed" });
    expect(await extractText("xlsx", Buffer.from("nope"))).toMatchObject({ status: "failed" });
  });

  it("is zip-bomb safe: oversized parts, too many entries and huge totals are refused without unpacking", async () => {
    const t0 = Date.now();
    const bomb = await extractText("docx", bombDocx(60)); // 60 MB of zeros in a few KB
    expect(bomb.status).toBe("failed");
    expect(bomb.error).toMatch(/too large once unpacked/);

    const many: Record<string, Uint8Array> = { "word/document.xml": strToU8("<w:t>x</w:t>") };
    for (let i = 0; i < MAX_ZIP_ENTRIES + 10; i++) many[`junk/${i}.txt`] = strToU8("x");
    const tooMany = await extractText("docx", Buffer.from(zipSync(many)));
    expect(tooMany.status).toBe("failed");
    expect(tooMany.error).toMatch(/too many files/);

    // Many unwanted parts that are individually fine but huge together are refused too, and never inflated.
    const parts: Record<string, Uint8Array> = { "word/document.xml": strToU8("<w:t>x</w:t>") };
    for (let i = 0; i < 11; i++) parts[`media/${i}.bin`] = new Uint8Array(10 * 1024 * 1024);
    const total = await extractText("xlsx", Buffer.from(zipSync(parts, { level: 1 })));
    expect(total.status).toBe("failed");
    expect(total.error).toMatch(/too large once unpacked/);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("escapes search snippets: markup in a document can never become HTML", () => {
    expect(escapeHtml(`<img src=x onerror="alert(1)">&'`)).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;");
    const s = safeSnippet("before <script>alert(1)</script> \u0001match\u0002 after\n  more");
    expect(s).toBe("before &lt;script&gt;alert(1)&lt;/script&gt; <mark>match</mark> after more");
    expect(s).not.toMatch(/<script/);
  });
});
