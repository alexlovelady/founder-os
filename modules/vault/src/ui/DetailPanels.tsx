"use client";
import { useEffect, useRef, useState } from "react";
import { legalReviewUrl } from "../legallink";
import { BASE, PlanLink, readError, type DetailDto, type ExtractionDto, type LegalLinkDto, type SuggestionDto, type SummaryDto } from "./shared";

const card = "space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-4";

const STATUS_LABEL: Record<ExtractionDto["status"], string> = {
  none: "Not read yet",
  pending: "Reading text…",
  ready: "Text ready",
  failed: "Text could not be read",
  unsupported: "Text not available",
};
const STATUS_TONE: Record<ExtractionDto["status"], string> = {
  none: "border-slate-600 bg-slate-800 text-slate-300",
  pending: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  ready: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  failed: "border-red-500/40 bg-red-500/10 text-red-300",
  unsupported: "border-amber-500/40 bg-amber-500/10 text-amber-300",
};

export function ExtractionPanel({ docId, extraction, canWrite, onDetail }: { docId: string; extraction: ExtractionDto; canWrite: boolean; onDetail: (d: DetailDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<{ text: string; truncated: boolean; chars: number }>();
  const [open, setOpen] = useState(false);

  async function reextract() {
    setBusy(true); setError(undefined); setPreview(undefined);
    const r = await fetch(`${BASE}/documents/${docId}/extract`, { method: "POST" });
    setBusy(false);
    if (!r.ok) { setError(await readError(r)); return; }
    onDetail(await r.json());
  }

  useEffect(() => {
    if (!open || extraction.status !== "ready") return;
    let live = true;
    void fetch(`${BASE}/documents/${docId}/text`).then(async (r) => {
      if (!live) return;
      if (!r.ok) { setError(await readError(r)); return; }
      setPreview(await r.json());
    });
    return () => { live = false; };
  }, [open, docId, extraction.status, extraction.extractedAt]);

  return (
    <section aria-label="Extracted text" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Text of this file</h2>
        <div className="flex items-center gap-3">
          <span className={`inline-block rounded-full border px-2 py-0.5 text-xs ${STATUS_TONE[extraction.status]}`} role="status">
            {STATUS_LABEL[extraction.status]}{extraction.status === "ready" && extraction.pageCount ? ` · ${extraction.pageCount} page${extraction.pageCount === 1 ? "" : "s"}` : ""}
          </span>
          {canWrite && <button type="button" disabled={busy} onClick={() => void reextract()} className="text-xs underline disabled:opacity-50">{busy ? "Reading…" : "Re-extract"}</button>}
        </div>
      </div>
      {extraction.error && extraction.status !== "ready" && (
        <p className="text-sm text-slate-300">
          {extraction.needsOcr ? "This looks like a scanned image with no text layer. Send it to LegalAI, which runs OCR, to read it." : extraction.error}
        </p>
      )}
      {error && <p role="alert" className="text-sm text-red-300">{error}<PlanLink msg={error} /></p>}
      {extraction.status === "ready" && (
        <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="cursor-pointer text-xs text-slate-400">Preview the first 5,000 characters</summary>
          {preview ? (
            <>
              <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs text-slate-300" tabIndex={0} aria-label="Extracted text preview">{preview.text}</pre>
              {preview.truncated && <p className="mt-1 text-xs text-slate-500">Showing 5,000 of {preview.chars.toLocaleString()} characters.</p>}
            </>
          ) : (
            <p className="mt-2 text-xs text-slate-500">Loading…</p>
          )}
        </details>
      )}
    </section>
  );
}

export function SuggestionChip({ docId, suggestion, canWrite, onApplied }: { docId: string; suggestion: SuggestionDto; canWrite: boolean; onApplied: (d: { category: string; docType: string }) => void }) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (hidden) return null;
  async function apply() {
    setBusy(true); setError(undefined);
    const r = await fetch(`${BASE}/documents/${docId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category: suggestion.category, docType: suggestion.docType }) });
    setBusy(false);
    if (!r.ok) { setError(await readError(r)); return; }
    onApplied({ category: suggestion.category, docType: suggestion.docType });
  }
  return (
    <section aria-label="Suggested classification" className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-300">Looks like a <strong>{suggestion.docType}</strong> ({suggestion.category}){suggestion.confidence === "medium" ? ", but we are not sure" : ""}.</span>
        {canWrite && (
          <>
            <button type="button" disabled={busy} onClick={() => void apply()} className="rounded-full bg-sky-600 px-3 py-1 text-xs font-medium disabled:opacity-50">{busy ? "Applying…" : "Use this"}</button>
            <button type="button" onClick={() => setHidden(true)} className="text-xs text-slate-400 underline">Not now</button>
          </>
        )}
      </div>
      {suggestion.evidence.length > 0 && <p className="mt-1 text-xs text-slate-500">Because it contains: {suggestion.evidence.join(", ")}. This is a keyword guess, not a legal reading.</p>}
      {error && <p role="alert" className="mt-1 text-xs text-red-300">{error}<PlanLink msg={error} /></p>}
    </section>
  );
}

export function SummaryBox({ docId, initial, pending, canWrite, hasText }: { docId: string; initial: SummaryDto | null; pending: boolean; canWrite: boolean; hasText: boolean }) {
  const [summary, setSummary] = useState(initial);
  const [state, setState] = useState<"idle" | "running" | "waiting" | "failed">(pending ? "running" : "idle");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  async function poll() {
    const r = await fetch(`${BASE}/documents/${docId}/summary`);
    if (!r.ok) { setState("failed"); setError(await readError(r)); return; }
    const d = await r.json();
    if (d.summary) setSummary(d.summary);
    if (d.state === "running" || d.state === "waiting") {
      setState(d.state); setMessage(d.message);
      timer.current = setTimeout(() => void poll(), 2500);
    } else if (d.state === "failed") {
      setState("failed"); setError(d.error ?? "The summary did not finish.");
    } else {
      setState("idle"); setMessage(undefined);
    }
  }

  useEffect(() => {
    if (pending) void poll();
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  async function start() {
    setError(undefined); setState("running"); setMessage(undefined);
    const r = await fetch(`${BASE}/documents/${docId}/summary`, { method: "POST" });
    if (!r.ok) { setState("failed"); setError(await readError(r)); return; }
    timer.current = setTimeout(() => void poll(), 1500);
  }

  const busy = state === "running" || state === "waiting";
  return (
    <section aria-label="AI summary" className={card}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Summary</h2>
        {canWrite && <button type="button" disabled={busy || !hasText} onClick={() => void start()} className="text-xs underline disabled:opacity-50">{busy ? "Summarizing…" : summary ? "Summarize again" : "Summarize with AI"}</button>}
      </div>
      {busy && <p role="status" className="flex items-center gap-2 text-sm text-slate-300"><span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-400" aria-hidden />{state === "waiting" && message ? message : "Writing the summary…"}</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}<PlanLink msg={error} /></p>}
      {!hasText && !summary && <p className="text-xs text-slate-500">A summary needs readable text; this file has none yet.</p>}
      {summary && (
        <div>
          <p className="whitespace-pre-wrap text-sm text-slate-200">{summary.text}</p>
          <p className="mt-2 text-xs text-amber-300/80">{summary.label}.{summary.truncated ? " Only the first 6,000 characters of the document were used." : ""}{summary.createdAt ? ` Written ${summary.createdAt.slice(0, 10)}${summary.version ? ` from version ${summary.version}` : ""}.` : ""}</p>
        </div>
      )}
    </section>
  );
}

const PERSPECTIVES: { id: string; label: string; hint: string }[] = [
  { id: "customer", label: "I am the customer / buyer", hint: "You are paying for goods or services." },
  { id: "vendor", label: "I am the vendor / seller", hint: "You are providing goods or services." },
  { id: "employer", label: "I am the employer", hint: "You are hiring or engaging someone." },
  { id: "employee", label: "I am the employee / contractor", hint: "You are being hired or engaged." },
  { id: "neutral", label: "Neutral / not sure", hint: "A balanced read of both sides." },
];

export function LegalPanel({ docId, docName, canWrite, initial }: { docId: string; docName: string; canWrite: boolean; initial: LegalLinkDto | null }) {
  const [link, setLink] = useState(initial);
  const [perspective, setPerspective] = useState(initial?.perspective ?? "customer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  async function send() {
    setBusy(true); setError(undefined); setNotice(undefined);
    let r: Response;
    try {
      r = await fetch("/api/legalbridge/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ documentId: docId, perspective }) });
    } catch {
      setBusy(false); setError("Could not reach the server. Check your connection and try again."); return;
    }
    setBusy(false);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { setError(d.error ?? "Something went wrong sending the document to LegalAI."); return; }
    if (d.state === "processing") {
      setNotice(d.message ?? "LegalAI is still reading the file. Try again in a minute.");
      return;
    }
    setLink({ legalDocumentId: d.legalDocumentId, legalReviewId: d.reviewId, legalWorkspaceId: d.workspaceId ?? null, perspective, version: 0, createdAt: new Date().toISOString() });
    setNotice("Sent to LegalAI. The review is running and can take a few minutes.");
    dialog.current?.close();
  }

  return (
    <section aria-label="Legal review" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Legal review</h2>
        {link?.legalReviewId && <a href={legalReviewUrl(link.legalWorkspaceId, link.legalReviewId)} className="text-sm text-sky-300 underline">Reviewed in LegalAI, open</a>}
      </div>
      <p className="text-xs text-slate-400">LegalAI reads the contract, flags risky terms and suggests changes. It is a tool to prepare for a conversation with a lawyer, not a substitute for one.</p>
      {canWrite ? (
        <button ref={opener} type="button" onClick={() => { setError(undefined); dialog.current?.showModal(); }} className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium">{link?.legalReviewId ? "Review again in LegalAI" : "Review in LegalAI"}</button>
      ) : (
        <p className="text-xs text-slate-500">Your role can view this document but not send it to LegalAI.</p>
      )}
      {notice && <p role="status" className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2 text-sm text-emerald-300">{notice}</p>}

      <dialog ref={dialog} aria-labelledby="legal-dialog-title" onClose={() => opener.current?.focus()} className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-0 text-slate-100 backdrop:bg-black/60">
        <form method="dialog" onSubmit={(e) => { e.preventDefault(); void send(); }} className="space-y-3 p-5">
          <h3 id="legal-dialog-title" className="text-base font-semibold">Review &ldquo;{docName}&rdquo; in LegalAI</h3>
          <p className="text-sm text-slate-400">A copy of this file is sent to your business&rsquo;s LegalAI workspace and a contract review is started. Your original stays in the vault.</p>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Which side are you on?</legend>
            {PERSPECTIVES.map((p) => (
              <label key={p.id} className="flex items-start gap-2 text-sm">
                <input type="radio" name="perspective" value={p.id} checked={perspective === p.id} onChange={() => setPerspective(p.id)} className="mt-1" />
                <span>{p.label}<span className="block text-xs text-slate-500">{p.hint}</span></span>
              </label>
            ))}
          </fieldset>
          {error && <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">{error}<PlanLink msg={error} /></p>}
          {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => dialog.current?.close()} className="rounded-lg border border-slate-700 px-4 py-1.5 text-sm">Cancel</button>
            <button type="submit" disabled={busy} className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-medium disabled:opacity-50">{busy ? "Sending…" : "Send and start review"}</button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
