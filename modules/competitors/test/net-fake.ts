import { gzipSync } from "node:zlib";
import type { NetDeps, RawResponse } from "../src/safe-fetch";

export interface Route { status?: number; type?: string | null; headers?: Record<string, string>; body?: string | Buffer; bytes?: number; hang?: boolean }
export interface Call { url: string; host: string; path: string; address: string; headers: Record<string, string> }

export const PUBLIC_IP = "93.184.216.34";

/** A fake network: DNS answers and HTTP routes are scripted; nothing leaves the process. */
export function makeNet(pages: (url: URL, call: Call) => Route | undefined, dns: Record<string, string[]> = {}) {
  const calls: Call[] = [];
  const resolved: string[] = [];
  const net: NetDeps = {
    async resolve(host) {
      resolved.push(host);
      if (host === "nxdomain.invalid-host.com") throw new Error("ENOTFOUND");
      return dns[host] ?? [PUBLIC_IP];
    },
    async request({ url, address, headers }) {
      const call: Call = { url: url.toString(), host: url.hostname, path: `${url.pathname}${url.search}`, address, headers };
      calls.push(call);
      const r = pages(url, call) ?? { status: 404, body: "not found" };
      if (r.hang) await new Promise(() => undefined);
      const buf = r.bytes != null ? Buffer.alloc(r.bytes, "a") : Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? "");
      let destroyed = false;
      const res: RawResponse = {
        status: r.status ?? 200,
        headers: { ...(r.type === null ? {} : { "content-type": r.type ?? "text/html; charset=utf-8" }), ...(r.headers ?? {}) },
        body: (async function* () {
          for (let i = 0; i < buf.length && !destroyed; i += 16384) yield new Uint8Array(buf.subarray(i, i + 16384));
        })(),
        destroy() { destroyed = true; },
      };
      return res;
    },
  };
  return { net, calls, resolved };
}

export const redirect = (to: string, status = 302): Route => ({ status, headers: { location: to }, body: "" });
export const gz = (s: string | Buffer): Route => ({ body: gzipSync(s), headers: { "content-encoding": "gzip" } });
