"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { parseMarkdown, type Inline } from "../markdown";

export interface Doc {
  id: string; title: string; kind: string; body?: string; status: "draft" | "active" | "archived"; owner: string;
  reviewFrequency: "none" | "quarterly" | "yearly"; lastReviewed: string | null; version: number; nextReview: string | null; createdAt: string; updatedAt: string;
}

export const API = "/api/tools/sops";
export const input = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100";
export const btn = "rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-50";
export const btn2 = "rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";

export async function api<T = { error?: string }>(path: string, method = "GET", body?: unknown): Promise<{ ok: boolean; status: number; data: T }> {
  const r = await fetch(`${API}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export type JobState = { state: "idle" } | { state: "waiting"; message?: string } | { state: "running" } | { state: "done"; text: string } | { state: "failed"; error: string };

/** Starts an AI job and polls until it finishes. The GPU is slow, so the UI shows the state the whole time. */
export function useAiJob(onDone?: (text: string) => void) {
  const cb = useRef(onDone);
  useEffect(() => { cb.current = onDone; });
  const [job, setJob] = useState<JobState>({ state: "idle" });
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; clearTimeout(timer.current); }, []);

  const start = useCallback(async (body: unknown) => {
    clearTimeout(timer.current);
    setJob({ state: "waiting", message: "Sending to the AI..." });
    const r = await api<{ jobId?: string; error?: string }>("ai", "POST", body);
    if (!r.ok || !r.data.jobId) { setJob({ state: "failed", error: r.data.error ?? "Could not start the AI job" }); return; }
    const jobId = r.data.jobId;
    const began = Date.now();
    const tick = async () => {
      if (!alive.current) return;
      const p = await api<{ state?: string; text?: string; error?: string; message?: string }>(`ai/${encodeURIComponent(jobId)}`);
      if (!alive.current) return;
      if (!p.ok) { setJob({ state: "failed", error: p.data.error ?? "Lost track of the AI job" }); return; }
      if (p.data.state === "done") { const text = p.data.text ?? ""; setJob({ state: "done", text }); cb.current?.(text); return; }
      if (p.data.state === "failed") { setJob({ state: "failed", error: p.data.error ?? "The AI job failed" }); return; }
      if (Date.now() - began > 15 * 60_000) { setJob({ state: "failed", error: "Timed out waiting for the AI. Try again later." }); return; }
      setJob(p.data.state === "waiting" ? { state: "waiting", message: p.data.message } : { state: "running" });
      timer.current = setTimeout(tick, 2500);
    };
    timer.current = setTimeout(tick, 1200);
  }, []);
  return { job, start, reset: () => { clearTimeout(timer.current); setJob({ state: "idle" }); } };
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
      {job.state === "waiting" ? `Waiting in the AI queue${job.message ? `: ${job.message}` : ""}` : "The AI is writing"}... this can take a few minutes on the private GPU. You can keep working; this page will update.
    </p>
  );
}

function Inl({ inl }: { inl: Inline[] }) {
  return (
    <>
      {inl.map((n, i) =>
        n.t === "text" ? <span key={i}>{n.v}</span>
        : n.t === "b" ? <strong key={i}>{n.v}</strong>
        : n.t === "i" ? <em key={i}>{n.v}</em>
        : n.t === "code" ? <code key={i} className="rounded bg-slate-800 px-1">{n.v}</code>
        : <a key={i} href={n.href} className="underline" rel="noreferrer noopener" target="_blank">{n.v}</a>,
      )}
    </>
  );
}

/** Safe markdown preview: rendered from parsed data as React elements, never as raw HTML. */
export function Preview({ markdown }: { markdown: string }) {
  const blocks = parseMarkdown(markdown);
  if (!blocks.length) return <p className="text-sm text-slate-500">Nothing to preview yet.</p>;
  return (
    <div className="space-y-3 text-sm leading-relaxed text-slate-200">
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": return <div key={i} role="heading" aria-level={b.level} className={b.level === 1 ? "text-xl font-semibold" : b.level === 2 ? "mt-2 text-base font-semibold" : "font-medium"}><Inl inl={b.inl} /></div>;
          case "p": return <p key={i}><Inl inl={b.inl} /></p>;
          case "ul": return <ul key={i} className="list-disc space-y-1 pl-5">{b.items.map((x, j) => <li key={j}><Inl inl={x} /></li>)}</ul>;
          case "ol": return <ol key={i} className="list-decimal space-y-1 pl-5">{b.items.map((x, j) => <li key={j}><Inl inl={x} /></li>)}</ol>;
          case "task": return <ul key={i} className="space-y-1">{b.items.map((x, j) => <li key={j}><span aria-hidden>{x.done ? "☑" : "☐"}</span> <Inl inl={x.inl} /></li>)}</ul>;
          case "quote": return <blockquote key={i} className="border-l-2 border-slate-600 pl-3 text-slate-400"><Inl inl={b.inl} /></blockquote>;
          case "hr": return <hr key={i} className="border-slate-700" />;
          case "code": return <pre key={i} className="overflow-x-auto rounded bg-slate-900 p-2 text-xs">{b.v}</pre>;
        }
      })}
    </div>
  );
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export const fileName = (title: string) => title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase().slice(0, 60) || "document";
