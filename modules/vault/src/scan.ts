/**
 * Upload scanning for the vault: heuristics for active content, plus an optional ClamAV (clamd) pass.
 *
 * These are the same ideas as LegalAI's built-in scanner (modules/legal/api/legalai/scanning.py: macros, ActiveX/OLE objects, PDF launch and
 * JavaScript actions, executables disguised as documents, the EICAR test file), ported to TypeScript and extended a little. They are
 * heuristics, not antivirus: they refuse the common ways a document carries code, and they miss anything cleverly hidden (for example PDF
 * objects inside compressed object streams). Set CLAMD_HOST (and CLAMD_PORT, default 3310) to add real signature scanning.
 *
 * `scanUpload` is pure and synchronous. `clamdScan` / `scanUploadFull` do the network part. Neither ever logs file contents.
 */
import { createConnection } from "node:net";
import { unzipSync } from "fflate";

export interface ScanResult {
  verdict: "clean" | "blocked";
  findings: string[];
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const EXEC_EXT = /\.(exe|dll|scr|bat|cmd|com|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|lnk|jar|cpl|reg|sh)$/i;
const SCRIPT_SCHEME = /^\s*(javascript|vbscript|data|file|ms-?[a-z]+|search-ms|jar):/i;
const MAX_PART = 5 * 1024 * 1024; // the largest xml/rels part we will inflate to look at

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
const has = (b: Uint8Array, sig: number[], at: number) => at >= 0 && at + sig.length <= b.length && sig.every((v, i) => b[at + i] === v);
const indexOfSeq = (b: Uint8Array, sig: number[] | string, from = 0): number => Buffer.from(b.buffer, b.byteOffset, b.byteLength).indexOf(typeof sig === "string" ? Buffer.from(sig, "latin1") : Buffer.from(sig), from);
const lastIndexOfSeq = (b: Uint8Array, sig: number[]): number => Buffer.from(b.buffer, b.byteOffset, b.byteLength).lastIndexOf(Buffer.from(sig));

/** Archive and executable signatures that should never follow the end of an image. */
function payloadIn(b: Uint8Array, from: number): string | null {
  const tail = b.subarray(from);
  if (tail.length < 4) return null;
  const buf = Buffer.from(tail.buffer, tail.byteOffset, tail.byteLength);
  if (buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) >= 0) return "a zip archive";
  if (buf.indexOf(Buffer.from("Rar!", "latin1")) >= 0) return "a RAR archive";
  if (buf.indexOf(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) >= 0) return "a 7-Zip archive";
  if (buf.indexOf(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) >= 0) return "an ELF executable";
  if (buf.indexOf(Buffer.from("MZ", "latin1")) >= 0 && buf.indexOf(Buffer.from("This program", "latin1")) >= 0) return "a Windows executable";
  if (has(tail, [0x4d, 0x5a], 0)) return "a Windows executable";
  return null;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

const SAFE_LINK = /^(https?:|mailto:|tel:|#)/i;

/** The path part of a target (a host such as example.com is not a file extension). */
function pathOf(t: string): string {
  const noQuery = t.split(/[?#]/)[0];
  if (/^(mailto|tel):/i.test(noQuery)) return "";
  return noQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
}

/** Judge one relationship target. Returns a finding, or null when it is fine. */
function externalTarget(type: string, target: string): string | null {
  const t = target.trim();
  const kind = type.slice(type.lastIndexOf("/") + 1);
  if (SCRIPT_SCHEME.test(t)) return `an external link to a script or local-file address (${kind})`;
  if (EXEC_EXT.test(pathOf(t))) return `an external link to an executable or script file (${kind})`;
  if (kind === "hyperlink") return SAFE_LINK.test(t) || !/^[a-z][a-z0-9+.-]*:/i.test(t) ? null : "an external link with an unusual address scheme";
  if (kind === "externalLinkPath") return null; // a linked workbook: only the checks above apply
  return /^https:\/\//i.test(t) ? null : `an external ${kind} reference that does not use https (it would be fetched when the file is opened)`;
}

function scanZipOffice(bytes: Uint8Array, findings: string[]) {
  const raw = latin1(bytes);
  if (/vbaProject\.bin/i.test(raw)) findings.push("contains a VBA macro project");
  if (/macrosheets\//i.test(raw)) findings.push("contains Excel 4.0 macro sheets");
  if (/\/activeX\/|activeX\d*\.(xml|bin)/i.test(raw)) findings.push("contains ActiveX controls");
  if (/(word|xl|ppt)\/embeddings\/|oleObject\d*\.bin/i.test(raw)) findings.push("contains embedded OLE objects");

  const names: string[] = [];
  let parts: Record<string, Uint8Array> = {};
  try {
    parts = unzipSync(bytes, {
      filter: (f) => {
        names.push(f.name);
        return f.originalSize <= MAX_PART && /(\.rels$|^\[Content_Types\]\.xml$|^word\/[^/]+\.xml$|^xl\/externalLinks\/[^/]+\.xml$)/.test(f.name);
      },
    });
  } catch {
    return; // not a readable zip: validateFile and the extractor report that; the raw checks above still ran
  }
  for (const n of names) {
    const norm = n.replace(/\\/g, "/");
    if (norm.startsWith("/") || norm.split("/").includes("..")) findings.push("contains a file with an unsafe path inside the archive");
    else if (EXEC_EXT.test(norm)) findings.push(`contains an embedded executable or script file (${norm.slice(norm.lastIndexOf("/") + 1)})`);
  }
  for (const [name, data] of Object.entries(parts)) {
    const xml = Buffer.from(data).toString("utf8");
    if (name === "[Content_Types].xml") {
      if (/macroEnabled|vbaProject|ms-office\.activeX|oleObject/i.test(xml)) findings.push("declares macro-enabled or ActiveX/OLE content");
    } else if (name.endsWith(".rels")) {
      for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
        const a = attrs(m[0]);
        if (!/^external$/i.test(a.TargetMode ?? "")) {
          if (/\/(oleObject|package|vbaProject|activeXControlBinary)$/i.test(a.Type ?? "")) findings.push("links an embedded OLE object, package or macro project");
          continue;
        }
        const f = externalTarget(a.Type ?? "", a.Target ?? "");
        if (f) findings.push(`has ${f}`);
      }
    } else if (/^word\//.test(name)) {
      const instr = [...xml.matchAll(/<w:instrText[^>]*>([^<]*)<\/w:instrText>/g)].map((m) => m[1]).join("") + [...xml.matchAll(/w:instr="([^"]*)"/g)].map((m) => m[1]).join(" ");
      if (/\bDDE(AUTO)?\b/i.test(instr)) findings.push("contains a DDE field (can run a command when opened)");
    } else if (/^xl\/externalLinks\//.test(name) && /<ddeLink\b/i.test(xml)) {
      findings.push("contains a DDE link (can run a command when opened)");
    }
  }
}

function scanOle(bytes: Uint8Array, findings: string[]) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (s: string) => buf.indexOf(Buffer.from(s, "utf16le")) >= 0;
  if (u16("_VBA_PROJECT") || u16("VBA") && u16("PROJECT")) findings.push("contains a VBA macro project");
  if (u16("Ole10Native") || u16("ObjectPool")) findings.push("contains embedded OLE objects");
  if (/\bDDE(AUTO)?\b/.test(latin1(bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)))) && u16("DDEAUTO")) findings.push("contains a DDE field");
}

function scanRtf(raw: string, findings: string[]) {
  if (/\\objdata\b|\\objautlink\b|\\objemb\b|\\objupdate\b/i.test(raw)) findings.push("contains embedded or auto-updating OLE objects");
}

/** PDF: normalise #XX escapes in names so /J#61vaScript is seen as /JavaScript, then look for active-content names. */
function scanPdf(bytes: Uint8Array, findings: string[]) {
  const raw = latin1(bytes).replace(/\/([A-Za-z0-9#]+)/g, (_m, n: string) => "/" + n.replace(/#([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))));
  const tests: [RegExp, string][] = [
    [/\/JavaScript(?![A-Za-z0-9])/, "contains JavaScript"],
    [/\/JS(?![A-Za-z0-9])/, "contains JavaScript"],
    [/\/Launch(?![A-Za-z0-9])/, "contains a Launch action (can start a program)"],
    [/\/EmbeddedFile(?![A-Za-z0-9])/, "contains an embedded file"],
    [/\/RichMedia(?![A-Za-z0-9])/, "contains embedded rich media"],
  ];
  for (const [re, msg] of tests) if (re.test(raw) && !findings.includes(msg)) findings.push(msg);
}

function scanImage(bytes: Uint8Array, ext: string, findings: string[]) {
  let end = -1;
  if (ext === "jpg" || ext === "jpeg") {
    const i = lastIndexOfSeq(bytes, [0xff, 0xd9]);
    if (i >= 0) end = i + 2;
  } else if (ext === "png") {
    // Walk the chunks to the real IEND (length, type, data, crc).
    let p = 8;
    while (p + 12 <= bytes.length) {
      const len = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
      const isEnd = has(bytes, [0x49, 0x45, 0x4e, 0x44], p + 4);
      p += 12 + len;
      if (isEnd) {
        end = p;
        break;
      }
    }
  } else if (ext === "webp") {
    const size = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
    end = (size >>> 0) + 8;
  }
  if (end > 0 && end < bytes.length) {
    const what = payloadIn(bytes, end);
    if (what) findings.push(`has ${what} hidden after the end of the image`);
  }
  if (indexOfSeq(bytes, "This program cannot be run") >= 0) findings.push("has a Windows executable hidden inside the image");
}

const HTML_HEAD = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)?<(?:!doctype\s+html|html|head|body|svg|script|iframe|object|embed|meta|link|form|a\s|div|img)\b/i;

/**
 * Scan an upload that has already passed `validateFile`. `type` is the normalised extension ("pdf", "docx", ...).
 * Blocked means the vault must refuse the file; findings are short plain-English reasons (never file contents).
 */
export function scanUpload(filename: string, bytes: Uint8Array, type?: string): ScanResult {
  const ext = (type ?? filename.slice(filename.lastIndexOf(".") + 1)).toLowerCase();
  const findings: string[] = [];
  const head = latin1(bytes.subarray(0, 4096));

  if (latin1(bytes).includes(EICAR)) findings.push("matches the standard antivirus test signature");
  if (has(bytes, [0x4d, 0x5a], 0) || has(bytes, [0x7f, 0x45, 0x4c, 0x46], 0)) findings.push("is an executable, not a document");

  // HTML or SVG pretending to be something else (a browser could run its script if it were ever served inline).
  const bom = head.charCodeAt(0) === 0xef ? head.slice(3) : head;
  if (HTML_HEAD.test(bom)) findings.push("is HTML or SVG markup that can run scripts, not a " + ext.toUpperCase() + " file");

  switch (ext) {
    case "docx":
    case "xlsx":
      scanZipOffice(bytes, findings);
      break;
    case "doc":
      if (head.startsWith("{\\rtf")) scanRtf(latin1(bytes), findings);
      else scanOle(bytes, findings);
      break;
    case "pdf":
      scanPdf(bytes, findings);
      break;
    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
      scanImage(bytes, ext, findings);
      break;
    case "txt":
    case "csv":
    case "md": {
      const sample = bytes.subarray(0, 8192);
      let ctl = 0;
      for (const c of sample) if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctl++;
      if (sample.length > 0 && (sample.includes(0) || ctl / sample.length > 0.05)) findings.push("contains binary data, not text");
      if (/^\s*#!/.test(head) || has(bytes, [0x50, 0x4b, 0x03, 0x04], 0)) findings.push("is a script or archive, not text");
      break;
    }
  }
  const unique = [...new Set(findings)];
  return { verdict: unique.length ? "blocked" : "clean", findings: unique };
}

export interface ClamdOptions {
  host: string;
  port?: number;
  timeoutMs?: number;
  warn?: (msg: string) => void;
}

/** Stream bytes to clamd with the INSTREAM protocol. Resolves null when the daemon is unreachable or answers oddly (caller fails open). */
export function clamdScan(bytes: Uint8Array, o: ClamdOptions): Promise<{ infected: boolean; signature?: string } | null> {
  const timeout = o.timeoutMs ?? 10_000;
  const warn = o.warn ?? ((m: string) => console.warn(m));
  return new Promise((resolve) => {
    let done = false;
    let reply = "";
    const sock = createConnection({ host: o.host, port: o.port ?? 3310 });
    const finish = (v: { infected: boolean; signature?: string } | null, why?: string) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (!v && why) warn(`vault: ClamAV scan skipped (${why}); the built-in checks stand`);
      resolve(v);
    };
    sock.setTimeout(timeout, () => finish(null, "timed out"));
    sock.on("error", (e: NodeJS.ErrnoException) => finish(null, e.code ?? "connection error"));
    sock.on("data", (d) => {
      reply += d.toString("utf8");
      if (reply.length > 4096) finish(null, "unexpected reply");
    });
    sock.on("end", () => {
      const text = reply.replace(/\0/g, "").trim();
      if (/FOUND$/.test(text)) return finish({ infected: true, signature: text.replace(/^stream:\s*/, "").replace(/\s*FOUND$/, "").slice(0, 80) });
      if (/OK$/.test(text)) return finish({ infected: false });
      finish(null, text ? "scanner error reply" : "no reply");
    });
    sock.on("connect", () => {
      sock.write("zINSTREAM\0");
      const CHUNK = 64 * 1024;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const part = bytes.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4)); // zero-length chunk ends the stream
    });
  });
}

/** Built-in heuristics, then ClamAV when CLAMD_HOST is set (fail open, with a logged warning, if it cannot be reached). */
export async function scanUploadFull(filename: string, bytes: Uint8Array, type?: string, env: Record<string, string | undefined> = process.env): Promise<ScanResult> {
  const r = scanUpload(filename, bytes, type);
  if (r.verdict === "blocked" || !env.CLAMD_HOST) return r;
  const port = Number(env.CLAMD_PORT);
  const c = await clamdScan(bytes, { host: env.CLAMD_HOST, port: Number.isInteger(port) && port > 0 ? port : 3310 });
  if (c?.infected) return { verdict: "blocked", findings: [`flagged by the virus scanner${c.signature ? ` (${c.signature})` : ""}`] };
  return r;
}
