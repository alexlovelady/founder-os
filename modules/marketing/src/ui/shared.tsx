"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Flag } from "../guard";

export const API = "/api/tools/marketing";
export const input = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100";
export const btn = "rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-50";
export const btn2 = "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";

export interface Item { id: string; kind: string; title: string; body?: string; channel: string; status: "draft" | "ready" | "published"; scheduledFor: string | null; notes: string; createdAt: string; updatedAt: string }

export async function api<T = { error?: string }>(path: string, method = "GET", body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await fetch(`${API}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

export type JobState =
  | { state: "idle" } | { state: "waiting"; message?: string } | { state: "running" }
  | { state: "done"; text: string; flags: Flag[]; warning: string | null; suggestion?: Record<string, string> }
  | { state: "failed"; error: string };

/** Starts an async AI job (POST `startPath`) and polls jobs/:id until it ends. */
export function useAiJob(onDone?: (job: Extract<JobState, { state: "done" }>) => void) {
  const cb = useRef(onDone);
  useEffect(() => { cb.current = onDone; });
  const [job, setJob] = useState<JobState>({ state: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);

  const start = useCallback(async (startPath: string, body: unknown) => {
    clearTimeout(timer.current);
    setJob({ state: "waiting", message: "Sending to the AI..." });
    const r = await api<{ id?: string; error?: string }>(startPath, "POST", body);
    if (!r.ok || !r.data.id) { setJob({ state: "failed", error: r.data.error ?? "Could not start the AI job" }); return; }
    const id = r.data.id;
    const began = Date.now();
    const tick = async () => {
      if (!alive.current) return;
      const p = await api<{ state?: string; text?: string; flags?: Flag[]; warning?: string | null; suggestion?: Record<string, string>; error?: string; message?: string }>(`jobs/${id}`);
      if (!alive.current) return;
      if (!p.ok) { setJob({ state: "failed", error: p.data.error ?? "Lost track of the AI job" }); return; }
      if (p.data.state === "done") { const d = { state: "done" as const, text: p.data.text ?? "", flags: p.data.flags ?? [], warning: p.data.warning ?? null, suggestion: p.data.suggestion }; setJob(d); cb.current?.(d); return; }
      if (p.data.state === "failed") { setJob({ state: "failed", error: p.data.error ?? "The AI job failed" }); return; }
      if (Date.now() - began > 15 * 60_000) { setJob({ state: "failed", error: "Timed out waiting for the AI. Try again later." }); return; }
      setJob(p.data.state === "waiting" ? { state: "waiting", message: p.data.message } : { state: "running" });
      timer.current = setTimeout(tick, 2500);
    };
    timer.current = setTimeout(tick, 1200);
  }, []);
  return { job, start, busy: job.state === "waiting" || job.state === "running" };
}

export function JobStatus({ job }: { job: JobState }) {
  if (job.state === "idle" || job.state === "done") return null;
  if (job.state === "failed") return (
    <>
      <p className="text-sm text-red-300" role="alert">{job.error}</p>
      {/plan|limit/i.test(job.error) && <a className="text-sm underline" href="/app/billing">See plans and usage</a>}
    </>
  );
  return (
    <p className="text-sm text-slate-300" role="status" aria-live="polite">
      {job.state === "waiting" ? `Waiting in the AI queue${job.message ? `: ${job.message}` : ""}` : "The AI is writing"}... this can take a few minutes on the private GPU. You can keep working.
    </p>
  );
}

export function Warnings({ flags, warning }: { flags: Flag[]; warning: string | null }) {
  if (!flags.length) return null;
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-100" role="alert">
      <p className="font-medium">Check these before you use the draft</p>
      <p className="text-xs">{warning}</p>
      <ul className="mt-1 list-disc pl-5 text-xs">{flags.map((f, i) => <li key={i}><strong>{f.text}</strong>: {f.message}</li>)}</ul>
    </div>
  );
}
