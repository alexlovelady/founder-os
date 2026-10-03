/**
 * SSRF-safe page fetching. Competitor URLs are untrusted user input, so every request:
 *  - uses https only (http is upgraded to https, never fetched in the clear) on the default port;
 *  - resolves DNS ONCE, refuses private / loopback / link-local / metadata / reserved addresses (IPv4 and IPv6),
 *    and connects to that exact checked address (so a DNS answer cannot change between the check and the connection);
 *  - repeats all of this on EVERY redirect hop (max 3 redirects);
 *  - caps response size, total time and content types (text/html, text/plain);
 *  - identifies itself as FounderOS-Research/1.0.
 * Network access goes through `NetDeps` so tests can run without the internet.
 */
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export const USER_AGENT = "FounderOS-Research/1.0 (+https://founderos.app/bot; respects robots.txt)";
export const ROBOTS_TOKEN = "FounderOS-Research";

export const FETCH_LIMITS = { maxRedirects: 3, maxBytes: 1_500_000, timeoutMs: 15_000 };

export type BlockCode = "scheme" | "invalid" | "port" | "private" | "dns" | "redirects" | "size" | "type" | "timeout" | "robots" | "network";

export class FetchBlocked extends Error {
  constructor(public code: BlockCode, message: string) {
    super(message);
  }
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export interface NetDeps {
  resolve(host: string): Promise<string[]>;
  /** Make one GET to `address` (already checked) for the host in `url`. Must not follow redirects. */
  request(opts: { url: URL; address: string; headers: Record<string, string>; timeoutMs: number }): Promise<RawResponse>;
}

// ---------- address checks ----------

function parseIPv4(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n >= 0 && n <= 255) ? o : null;
}

export function isPublicIPv4(ip: string): boolean {
  const o = parseIPv4(ip);
  if (!o) return false;
  const [a, b, c] = o;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT (also Alibaba metadata)
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Eight 16-bit groups, or null if not a valid IPv6 address. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim().toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  if (s.includes(".")) {
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return null;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tail.length > 7) return null;
  const fill = halves.length === 2 ? new Array(8 - head.length - tail.length).fill("0") : [];
  const groups = [...head, ...fill, ...tail];
  if (groups.length !== 8) return null;
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return out.some(Number.isNaN) ? null : out;
}

const v4Of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

export function isPublicIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (!g) return false;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return isPublicIPv4(v4Of(g[6], g[7])); // IPv4-mapped
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPublicIPv4(v4Of(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) return isPublicIPv4(v4Of(g[1], g[2])); // 6to4
  if (g[0] === 0x2001 && g[1] < 0x0200) return false; // teredo and IETF protocol assignments
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  return g[0] >= 0x2000 && g[0] <= 0x3fff; // global unicast only; everything else (::1, fc00::/7, fe80::/10, ff00::/8, ::) is refused
}

export function isPublicIp(ip: string): boolean {
  const v = isIP(ip.replace(/^\[|\]$/g, ""));
  if (v === 4) return isPublicIPv4(ip);
  if (v === 6) return isPublicIPv6(ip.replace(/^\[|\]$/g, ""));
  return false;
}

// ---------- URL rules ----------

const BLOCKED_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet)$/;

/** Parse and normalise a URL for fetching: https only (http upgraded), default port, no credentials, a real public-looking host. */
export function normalizeFetchUrl(input: string | URL): URL {
  let u: URL;
  try {
    u = new URL(String(input));
  } catch {
    throw new FetchBlocked("invalid", "That is not a valid web address");
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") throw new FetchBlocked("scheme", "Only https addresses can be fetched");
  if (u.username || u.password) throw new FetchBlocked("invalid", "Addresses with credentials are not allowed");
  if (u.port && u.port !== "443") throw new FetchBlocked("port", "Only the standard https port is allowed");
  u.port = "";
  u.hash = "";
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) throw new FetchBlocked("invalid", "The address has no host name");
  u.hostname = host;
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 0 && (!host.includes(".") || BLOCKED_NAMES.test(host))) throw new FetchBlocked("private", "That host name is not a public website");
  return u;
}

/** Throws unless every address the host resolves to is public. Returns the address to connect to. */
export async function checkHost(u: URL, deps: Pick<NetDeps, "resolve">): Promise<string> {
  const bare = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (isIP(bare) !== 0) {
    addrs = [bare];
  } else {
    try {
      addrs = await deps.resolve(bare);
    } catch {
      throw new FetchBlocked("dns", "The host name could not be resolved");
    }
  }
  if (addrs.length === 0) throw new FetchBlocked("dns", "The host name could not be resolved");
  for (const a of addrs) if (!isPublicIp(a)) throw new FetchBlocked("private", "That address points to a private or internal network and was not fetched");
  return addrs[0];
}

// ---------- fetching ----------

export interface SafeFetchOptions {
  maxRedirects?: number;
  maxBytes?: number;
  timeoutMs?: number;
  allowTypes?: string[];
  /** Called with every URL (first request and each redirect hop) after the address checks. Throw to refuse (used for robots.txt). */
  beforeRequest?: (url: URL) => Promise<void>;
}

export interface SafeResponse {
  status: number;
  finalUrl: string;
  contentType: string;
  text: string;
  redirects: number;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

function decode(buf: Buffer, contentType: string): string {
  const cs = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

export async function safeFetch(input: string | URL, deps: NetDeps, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const maxRedirects = opts.maxRedirects ?? FETCH_LIMITS.maxRedirects;
  const maxBytes = opts.maxBytes ?? FETCH_LIMITS.maxBytes;
  const timeoutMs = opts.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const allowTypes = opts.allowTypes ?? ["text/html", "text/plain"];
  const deadline = Date.now() + timeoutMs;
  let url = normalizeFetchUrl(input);
  let redirects = 0;

  const remaining = () => {
    const r = deadline - Date.now();
    if (r <= 0) throw new FetchBlocked("timeout", "The website took too long to answer");
    return r;
  };
  const withDeadline = <T>(p: Promise<T>, onTimeout?: () => void): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { onTimeout?.(); reject(new FetchBlocked("timeout", "The website took too long to answer")); }, remaining());
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
      p.catch(() => undefined);
    });

  for (;;) {
    const address = await withDeadline(checkHost(url, deps));
    await opts.beforeRequest?.(url);
    let res: RawResponse;
    try {
      res = await withDeadline(deps.request({ url, address, timeoutMs: remaining(), headers: { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9", "accept-encoding": "gzip, deflate, br" } }));
    } catch (e) {
      if (e instanceof FetchBlocked) throw e;
      throw new FetchBlocked("network", "The website could not be reached");
    }
    if (REDIRECT.has(res.status) && res.headers.location) {
      res.destroy();
      if (++redirects > maxRedirects) throw new FetchBlocked("redirects", "Too many redirects");
      try {
        url = normalizeFetchUrl(new URL(res.headers.location, url));
      } catch (e) {
        throw e instanceof FetchBlocked ? e : new FetchBlocked("invalid", "Bad redirect address");
      }
      continue;
    }
    const contentType = (res.headers["content-type"] ?? "").toLowerCase();
    const mime = contentType.split(";")[0].trim();
    if (res.status >= 200 && res.status < 300 && !allowTypes.includes(mime)) {
      res.destroy();
      throw new FetchBlocked("type", `Not a web page (content type ${mime || "unknown"})`);
    }
    if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
      res.destroy();
      throw new FetchBlocked("size", "The page is too large to read");
    }
    if (!(res.status >= 200 && res.status < 300)) {
      res.destroy();
      return { status: res.status, finalUrl: url.toString(), contentType: mime, text: "", redirects };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    await withDeadline((async () => {
      for await (const c of res.body) {
        total += c.byteLength;
        if (total > maxBytes) {
          res.destroy();
          throw new FetchBlocked("size", "The page is too large to read");
        }
        chunks.push(Buffer.from(c));
      }
    })(), () => res.destroy());
    let buf: Buffer<ArrayBufferLike> = Buffer.concat(chunks);
    const enc = (res.headers["content-encoding"] ?? "").toLowerCase().trim();
    try {
      if (enc === "gzip" || enc === "x-gzip") buf = gunzipSync(buf, { maxOutputLength: maxBytes });
      else if (enc === "deflate") buf = inflateSync(buf, { maxOutputLength: maxBytes });
      else if (enc === "br") buf = brotliDecompressSync(buf, { maxOutputLength: maxBytes });
      else if (enc && enc !== "identity") throw new FetchBlocked("type", "Unsupported content encoding");
    } catch (e) {
      throw e instanceof FetchBlocked ? e : new FetchBlocked("size", "The page is too large to read");
    }
    return { status: res.status, finalUrl: url.toString(), contentType: mime, text: decode(buf, contentType), redirects };
  }
}

// ---------- real network ----------

export const realNet: NetDeps = {
  async resolve(host) {
    const r = await lookup(host, { all: true, verbatim: true });
    return r.map((x) => x.address);
  },
  request({ url, address, headers, timeoutMs }) {
    return new Promise<RawResponse>((resolve, reject) => {
      // Connect to the already-checked address; TLS still validates the certificate against the real host name.
      const req = httpsRequest(
        { host: address, port: 443, path: `${url.pathname}${url.search}`, method: "GET", servername: isIP(url.hostname) ? undefined : url.hostname, headers: { ...headers, host: url.host }, timeout: timeoutMs },
        (res) => {
          const h: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h[k] = Array.isArray(v) ? v.join(", ") : String(v);
          resolve({ status: res.statusCode ?? 0, headers: h, body: res, destroy: () => res.destroy() });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });
  },
};
