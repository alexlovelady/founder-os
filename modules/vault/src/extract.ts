/**
 * Best-effort plain-text extraction for the vault (spec 17). Pure: bytes in, a result out, never throws.
 * Bounded on purpose: output is capped, Office files are unpacked only up to fixed size and entry limits (zip-bomb safe),
 * PDFs are limited by page count and a time limit. A failure here never fails an upload: the caller records the status.
 */
import { unzipSync } from "fflate";

export const MAX_TEXT_CHARS = 2 * 1024 * 1024; // stored text cap
export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ZIP_TOTAL_BYTES = 100 * 1024 * 1024; // sum of declared uncompressed sizes of ALL entries
export const MAX_ZIP_PART_BYTES = 25 * 1024 * 1024; // a single part we actually unpack
export const MAX_ZIP_UNPACKED_BYTES = 40 * 1024 * 1024; // all parts we actually unpack together
export const MAX_PDF_PAGES = 300;
export const PDF_TIMEOUT_MS = 20_000;

export type ExtractStatus = "ready" | "failed" | "unsupported";
export interface ExtractResult {
  status: ExtractStatus;
  text: string;
  pageCount: number | null;
  /** Plain-language reason when status is not "ready". Safe to show to the user. */
  error: string | null;
}

export const SCANNED_MESSAGE = "scanned image (send it to LegalAI, which runs OCR)";

const ok = (text: string, pageCount: number | null = null): ExtractResult => ({ status: "ready", text: clean(text), pageCount, error: null });
const failed = (error: string): ExtractResult => ({ status: "failed", text: "", pageCount: null, error });
const unsupported = (error: string): ExtractResult => ({ status: "unsupported", text: "", pageCount: null, error });

/** Normalise extracted text: no control characters (they would confuse search and the browser), tidy whitespace, hard cap. */
export function clean(raw: string): string {
  const t = raw
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f￾￿]/g, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) : t;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const t = new TextDecoder("utf-8").decode(bytes.subarray(0, MAX_TEXT_CHARS * 4 + 8));
  return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

class ZipLimit extends Error {}

/** Unpack only the wanted parts of an Office zip, refusing archives that are too big or have too many entries. */
function unzipParts(bytes: Uint8Array, want: (name: string) => boolean): Record<string, Uint8Array> {
  let entries = 0;
  let declared = 0;
  let unpacked = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(f) {
        entries++;
        declared += f.originalSize;
        if (entries > MAX_ZIP_ENTRIES) throw new ZipLimit("too many files inside");
        if (declared > MAX_ZIP_TOTAL_BYTES) throw new ZipLimit("too large once unpacked");
        if (!want(f.name)) return false;
        if (f.originalSize > MAX_ZIP_PART_BYTES) throw new ZipLimit("too large once unpacked");
        unpacked += f.originalSize;
        if (unpacked > MAX_ZIP_UNPACKED_BYTES) throw new ZipLimit("too large once unpacked");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof ZipLimit) throw new Error(`This file is ${e.message}, so its text was not read.`);
    throw new Error("The file could not be opened as an Office document (it may be damaged or password-protected).");
  }
  return files;
}

const utf8 = (b: Uint8Array) => new TextDecoder("utf-8").decode(b);

function docxText(bytes: Uint8Array): string {
  const parts = unzipParts(bytes, (n) => n === "word/document.xml" || n === "word/footnotes.xml" || n === "word/endnotes.xml");
  const out: string[] = [];
  for (const name of ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"]) {
    const xml = parts[name];
    if (!xml) continue;
    // Text only ever sits inside w:t (kept), w:instrText (field codes) and w:delText (deleted tracked changes); drop the last two, then all tags.
    const s = utf8(xml)
      .replace(/<w:(instrText|delText)\b[^>]*>[^<]*<\/w:\1>/g, "")
      .replace(/<w:tab\b[^>]*\/>/g, "\t")
      .replace(/<w:(br|cr)\b[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]*>/g, "");
    out.push(decodeXml(s));
  }
  return out.join("\n");
}

function xlsxText(bytes: Uint8Array): string {
  const parts = unzipParts(bytes, (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared: string[] = [];
  const ss = parts["xl/sharedStrings.xml"];
  if (ss) {
    for (const m of utf8(ss).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      let t = "";
      for (const x of m[1].matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)) t += x[1];
      shared.push(decodeXml(t));
    }
  }
  const out: string[] = [];
  const sheets = Object.keys(parts).filter((n) => n.startsWith("xl/worksheets/")).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of sheets) {
    for (const row of utf8(parts[name]).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const body = c[2] ?? "";
        const type = /\bt="([^"]*)"/.exec(c[1])?.[1];
        if (type === "s") {
          const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
          if (v !== undefined) cells.push(shared[Number(v)] ?? "");
        } else if (type === "inlineStr") {
          cells.push(decodeXml([...body.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join("")));
        } else {
          const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
          if (v !== undefined) cells.push(decodeXml(v));
        }
      }
      if (cells.some((c) => c.trim())) out.push(cells.join("\t"));
      if (out.length > 200_000) break;
    }
  }
  return out.join("\n");
}

async function pdfText(bytes: Uint8Array): Promise<ExtractResult> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  // pdfjs transfers/detaches the buffer it is given, so hand it a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const pages = Math.min(pdf.numPages, MAX_PDF_PAGES);
    const { text } = await extractText(pdf, { mergePages: false });
    const joined = (text as string[]).slice(0, pages).join("\n\n");
    const meaningful = joined.replace(/\s+/g, "");
    // A page of real prose has hundreds of characters. Almost nothing across the whole file means a scan (or an image-only PDF).
    if (meaningful.length < Math.min(40, pages * 10)) return unsupported(SCANNED_MESSAGE);
    return ok(joined, pdf.numPages);
  } finally {
    await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((res) => { t = setTimeout(() => res(onTimeout), ms); })]).finally(() => clearTimeout(t));
}

/** Extract plain text for a vault file. Never throws; the error message is safe to show and never contains file contents. */
export async function extractText(ext: string, bytes: Uint8Array): Promise<ExtractResult> {
  try {
    switch (ext.toLowerCase()) {
      case "txt":
      case "md":
      case "csv":
        return ok(decodeText(bytes));
      case "docx":
        return ok(docxText(bytes));
      case "xlsx":
        return ok(xlsxText(bytes));
      case "pdf": {
        const r = await withTimeout(pdfText(bytes), PDF_TIMEOUT_MS, failed("Reading this PDF took too long, so it was skipped."));
        return r;
      }
      case "doc":
        return unsupported("old Word (.doc) format; save it as .docx or PDF to read its text");
      case "png":
      case "jpg":
      case "jpeg":
      case "webp":
        return unsupported(SCANNED_MESSAGE);
      default:
        return unsupported(`text extraction is not available for .${ext} files`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (/password|encrypted/i.test(msg)) return failed("The PDF is password-protected, so its text could not be read.");
    if (e instanceof Error && msg.startsWith("This file ")) return failed(msg);
    if (e instanceof Error && msg.startsWith("The file could not")) return failed(msg);
    return failed("The text of this file could not be read.");
  }
}
