/**
 * Source health check (admin-triggered only, never automatic): "does this rule's source URL still load, and where does it end up?"
 *
 * A small local copy of the SSRF-safe approach used elsewhere in the product (this tool does not import other tools). Every request:
 *  - uses https only on the default port (http is upgraded, never fetched in the clear); no credentials in the address;
 *  - resolves DNS once, refuses private / loopback / link-local / metadata / reserved addresses (IPv4 and IPv6) and connects to that
 *    exact checked address, so a DNS answer cannot change between the check and the connection;
 *  - repeats the checks on EVERY redirect hop (max 3), and stops at 10 seconds in total;
 *  - never downloads the page body: only the status line and headers are read, then the connection is closed.
 * Network access goes through `NetDeps` so tests run without the internet. It reports what the server answered; it does not decide
 * whether the page still says what the rule says (a person has to read it).
 */
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const CHECK_LIMITS = { maxRedirects: 3, timeoutMs: 10_000 };
export const CHECK_USER_AGENT = "FounderOS-SourceCheck/1.0 (admin-triggered compliance source check)";

export type BlockCode = "scheme" | "invalid" | "port" | "private" | "dns" | "redirects" | "timeout" | "network";

export class CheckBlocked extends Error {
  constructor(public code: BlockCode, message: string) {
    super(message);
  }
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  destroy(): void;
}

export interface NetDeps {
  resolve(host: string): Promise<string[]>;
  /** Make one GET to `address` (already checked) for the host in `url`. Must not follow redirects and must not read the body. */
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
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return a < 224; // multicast, reserved, broadcast
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
  return g[0] >= 0x2000 && g[0] <= 0x3fff; // global unicast only
}

export function isPublicIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const v = isIP(bare);
  if (v === 4) return isPublicIPv4(bare);
  if (v === 6) return isPublicIPv6(bare);
  return false;
}

// ---------- URL rules ----------

const BLOCKED_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet)$/;

/** https only (http is upgraded), default port, no credentials, a real public-looking host. */
export function normalizeCheckUrl(input: string | URL): URL {
  let u: URL;
  try {
    u = new URL(String(input));
  } catch {
    throw new CheckBlocked("invalid", "That is not a valid web address");
  }
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.protocol !== "https:") throw new CheckBlocked("scheme", "Only https addresses can be checked");
  if (u.username || u.password) throw new CheckBlocked("invalid", "Addresses with credentials are not allowed");
  if (u.port && u.port !== "443") throw new CheckBlocked("port", "Only the standard https port is allowed");
  u.port = "";
  u.hash = "";
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  if (!host) throw new CheckBlocked("invalid", "The address has no host name");
  u.hostname = host;
  const bare = host.replace(/^\[|\]$/g, "");
  if (isIP(bare) === 0 && (!host.includes(".") || BLOCKED_NAMES.test(host))) throw new CheckBlocked("private", "That host name is not a public website");
  return u;
}

/** Throws unless every address the host resolves to is public. Returns the address to connect to. */
export async function checkHost(u: URL, deps: Pick<NetDeps, "resolve">): Promise<string> {
  const bare = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (isIP(bare) !== 0) addrs = [bare];
  else {
    try {
      addrs = await deps.resolve(bare);
    } catch {
      throw new CheckBlocked("dns", "The host name could not be resolved");
    }
  }
  if (addrs.length === 0) throw new CheckBlocked("dns", "The host name could not be resolved");
  for (const a of addrs) if (!isPublicIp(a)) throw new CheckBlocked("private", "That address points to a private or internal network and was not contacted");
  return addrs[0];
}

// ---------- the check ----------

export interface SourceCheckResult {
  /** True when the final answer was a 2xx. */
  ok: boolean;
  /** HTTP status of the final response, or null when nothing was fetched (blocked, DNS, timeout, network). */
  status: number | null;
  finalUrl: string | null;
  redirects: number;
  /** Plain-English summary for the admin. */
  note: string;
  /** Machine-readable reason when `status` is null. */
  blocked: BlockCode | null;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

export async function checkSourceUrl(input: string, deps: NetDeps, opts: { timeoutMs?: number; maxRedirects?: number } = {}): Promise<SourceCheckResult> {
  const timeoutMs = opts.timeoutMs ?? CHECK_LIMITS.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? CHECK_LIMITS.maxRedirects;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const r = deadline - Date.now();
    if (r <= 0) throw new CheckBlocked("timeout", "The website took too long to answer");
    return r;
  };
  const withDeadline = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new CheckBlocked("timeout", "The website took too long to answer")), remaining());
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });

  let current: string | null = null;
  let redirects = 0;
  try {
    let url = normalizeCheckUrl(input);
    current = url.toString();
    for (;;) {
      const address = await withDeadline(checkHost(url, deps));
      let res: RawResponse;
      try {
        res = await withDeadline(deps.request({ url, address, timeoutMs: remaining(), headers: { "user-agent": CHECK_USER_AGENT, accept: "text/html,*/*;q=0.5" } }));
      } catch (e) {
        if (e instanceof CheckBlocked) throw e;
        throw new CheckBlocked("network", "The website could not be reached");
      }
      res.destroy();
      if (REDIRECT.has(res.status) && res.headers.location) {
        if (++redirects > maxRedirects) throw new CheckBlocked("redirects", "Too many redirects");
        try {
          url = normalizeCheckUrl(new URL(res.headers.location, url));
        } catch (e) {
          throw e instanceof CheckBlocked ? e : new CheckBlocked("invalid", "Bad redirect address");
        }
        current = url.toString();
        continue;
      }
      const ok = res.status >= 200 && res.status < 300;
      const moved = redirects > 0 ? ` after ${redirects} redirect${redirects === 1 ? "" : "s"}` : "";
      const note = ok
        ? `The page answered ${res.status}${moved}. Open it and confirm it still says what the rule says.`
        : `The page answered ${res.status}${moved}. ${res.status === 403 || res.status === 429 ? "Many sites block automated checks; open it in a browser before concluding it is broken." : "Check the address and find the current page."}`;
      return { ok, status: res.status, finalUrl: url.toString(), redirects, note, blocked: null };
    }
  } catch (e) {
    const b = e instanceof CheckBlocked ? e : new CheckBlocked("network", "The website could not be reached");
    return { ok: false, status: null, finalUrl: current, redirects, note: b.message, blocked: b.code };
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
          resolve({ status: res.statusCode ?? 0, headers: h, destroy: () => res.destroy() });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end();
    });
  },
};
