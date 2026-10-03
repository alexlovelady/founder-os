/** File rules for the vault: allowed types, size cap, name sanitising, and content checks. Pure functions, no I/O. */

export const MAX_BYTES = 15 * 1024 * 1024;

export const ALLOWED = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8", // never text/html: markdown is served as plain text
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;
export type Ext = keyof typeof ALLOWED;
export const ALLOWED_LIST = Object.keys(ALLOWED).join(", ");

export class FileRejected extends Error {}

/** Keep only a safe base name: no path, no control or odd characters, bounded length. */
export function sanitizeFilename(raw: string): string {
  let name = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  name = name.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[^A-Za-z0-9 ._()\-]/g, "_").replace(/_{2,}/g, "_").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "");
  const dot = name.lastIndexOf(".");
  if (name.length > 120) {
    const ext = dot > 0 ? name.slice(dot).slice(0, 10) : "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || "file";
}

export function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i > 0 ? filename.slice(i + 1).toLowerCase() : "";
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const includes = (b: Uint8Array, text: string) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(text, 0, "latin1");

/** Executable and script signatures that are refused whatever the extension says. */
function looksExecutable(b: Uint8Array): boolean {
  return (
    startsWith(b, [0x4d, 0x5a]) || // MZ (Windows exe/dll)
    startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) || // ELF
    startsWith(b, [0x23, 0x21]) || // #! script
    startsWith(b, [0xca, 0xfe, 0xba, 0xbe]) || // Java class / Mach-O fat
    startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) ||
    startsWith(b, [0xce, 0xfa, 0xed, 0xfe])
  );
}

/**
 * Check a file is one of the allowed types and that its bytes match its extension. Returns the normalised extension.
 * Throws FileRejected with a message that is safe to show the user.
 */
export function validateFile(filename: string, bytes: Uint8Array): Ext {
  const ext = extOf(filename);
  if (!(ext in ALLOWED)) throw new FileRejected(`Files of type ".${ext || "(none)"}" are not allowed. Allowed types: ${ALLOWED_LIST}.`);
  if (bytes.byteLength === 0) throw new FileRejected("The file is empty.");
  if (bytes.byteLength > MAX_BYTES) throw new FileRejected("The file is larger than the 15 MB limit.");
  if (looksExecutable(bytes)) throw new FileRejected("Executable files are not allowed.");
  const bad = (what: string) => new FileRejected(`This file does not look like a real ${what} file; its contents do not match the ".${ext}" extension.`);
  switch (ext as Ext) {
    case "pdf":
      if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) throw bad("PDF");
      break;
    case "docx":
    case "xlsx": {
      if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) throw bad(ext === "docx" ? "Word" : "Excel");
      // Office files are zips; entry names are stored in the clear, so look for the parts every real one has.
      if (!includes(bytes, "[Content_Types].xml") || !includes(bytes, ext === "docx" ? "word/" : "xl/")) throw bad(ext === "docx" ? "Word" : "Excel");
      break;
    }
    case "png":
      if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) throw bad("PNG");
      break;
    case "jpg":
    case "jpeg":
      if (!startsWith(bytes, [0xff, 0xd8, 0xff])) throw bad("JPEG");
      break;
    case "webp":
      if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") throw bad("WebP");
      break;
    case "doc":
      // Old Word files are OLE containers; some are RTF. Anything else is not a Word file.
      if (!startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) && ascii(bytes, 0, 5) !== "{\\rtf") throw bad("Word");
      break;
    case "txt":
    case "csv":
    case "md":
      if (bytes.subarray(0, 8192).includes(0)) throw bad("text");
      break;
  }
  return ext as Ext;
}

/** The only content types the vault ever serves. */
export function safeContentType(ext: string): string {
  return (ALLOWED as Record<string, string>)[ext] ?? "application/octet-stream";
}

/** Content-Disposition value forcing a download, with an ASCII fallback and a UTF-8 name. */
export function attachmentHeader(filename: string): string {
  const safe = sanitizeFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
