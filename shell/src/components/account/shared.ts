export const inputCls = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400";
export const cardCls = "w-full max-w-sm space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6";
export const btnCls = "w-full rounded-lg bg-slate-100 px-4 py-2 font-medium text-slate-900 disabled:opacity-60";

/** POST JSON and return status plus parsed body. Never throws. */
export async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status, data: ((await r.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach the server. Check your connection and try again." } };
  }
}

/** Only same-site paths are followed after a successful call. */
export const safeNext = (n: unknown, fallback: string): string => (typeof n === "string" && n.startsWith("/") && !n.startsWith("//") && !n.includes("\\") ? n : fallback);
