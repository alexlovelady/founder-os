/** Tiny real files for the extraction tests, built in code (no binary fixtures in the repo). */
import { zipSync, strToU8 } from "fflate";

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A valid single- or multi-page PDF with a Helvetica text layer. `pages` is one array of lines per page. */
export function textPdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objs[4] = "<< >>";
  const wrap = (l: string) => l.match(/.{1,80}(\s|$)|\S+/g)?.map((x) => x.trimEnd()) ?? [l]; // pdfjs drops text that runs off the page
  pages.forEach((raw, i) => {
    const lines = raw.flatMap(wrap);
    const content = lines.length ? `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET` : "0.5 g 72 600 200 100 re f";
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';

/** A minimal .docx: one paragraph per string. */
export function docx(paragraphs: string[], extraParts: Record<string, Uint8Array> = {}): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`).join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return Buffer.from(zipSync({ "[Content_Types].xml": strToU8(CONTENT_TYPES), "word/document.xml": strToU8(xml), ...extraParts }));
}

/** A minimal .xlsx with one sheet; strings go through sharedStrings, numbers are plain. */
export function xlsx(rows: (string | number)[][]): Buffer {
  const strings: string[] = [];
  const sheet = rows
    .map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => {
      const ref = `${String.fromCharCode(65 + ci)}${ri + 1}`;
      if (typeof c === "number") return `<c r="${ref}"><v>${c}</v></c>`;
      strings.push(c);
      return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
    }).join("")}</row>`)
    .join("");
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(CONTENT_TYPES),
      "xl/workbook.xml": strToU8("<workbook/>"),
      "xl/sharedStrings.xml": strToU8(`<sst>${strings.map((s) => `<si><t>${xmlEsc(s)}</t></si>`).join("")}</sst>`),
      "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${sheet}</sheetData></worksheet>`),
    }),
  );
}

/** A docx whose document.xml is `megabytes` MB of zeros once unpacked but only a few KB on disk. */
export function bombDocx(megabytes: number): Buffer {
  return Buffer.from(zipSync({ "[Content_Types].xml": strToU8(CONTENT_TYPES), "word/document.xml": new Uint8Array(megabytes * 1024 * 1024) }, { level: 1 }));
}
