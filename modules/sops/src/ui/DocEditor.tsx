"use client";
import { useEffect, useState } from "react";
import { LinkedItems } from "@founderos/sdk/ui";
import { exportHtml, extractSteps, toChecklist } from "../markdown";
import { missingSections } from "../sop";
import { DOC_KINDS, KIND_LABEL } from "../templates";
import { api, btn, btn2, download, fileName, input, JobStatus, Preview, useAiJob, type Doc } from "./shared";

interface Version { version: number; title: string; note: string; changedBy: string; createdAt: string }

export default function DocEditor({ initial, canWrite, aiAvailable }: { initial: Doc; canWrite: boolean; aiAvailable: boolean }) {
  const [doc, setDoc] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body ?? "");
  const [kind, setKind] = useState(initial.kind);
  const [status, setStatus] = useState(initial.status);
  const [freq, setFreq] = useState(initial.reviewFrequency);
  const [note, setNote] = useState("");
  const [versions, setVersions] = useState<Version[]>([]);
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();
  const [aiShown, setAiShown] = useState(false);
  const [taskMsg, setTaskMsg] = useState<string>();

  const { job, start } = useAiJob((text) => { setBody(text); setAiShown(true); });

  const dirty = title !== doc.title || body !== (doc.body ?? "") || kind !== doc.kind || status !== doc.status || freq !== doc.reviewFrequency;
  useEffect(() => {
    let stale = false;
    void api<{ versions: Version[] }>(`documents/${doc.id}`).then((r) => { if (!stale && r.ok) setVersions(r.data.versions); });
    return () => { stale = true; };
  }, [doc.id, doc.version]);

  async function save() {
    setErr(undefined); setMsg(undefined);
    const r = await api<{ document?: Doc; error?: string }>(`documents/${doc.id}`, "PUT", { title, body, kind, status, review_frequency: freq, note });
    if (!r.ok || !r.data.document) { setErr(r.data.error ?? "Could not save"); return; }
    const d = { ...r.data.document };
    setDoc(d); setNote(""); setAiShown(false); setMsg("Saved.");
  }
  async function reviewed() {
    const r = await api<{ document?: Doc; error?: string }>(`documents/${doc.id}/reviewed`, "POST");
    if (r.ok && r.data.document) { setDoc({ ...doc, lastReviewed: r.data.document.lastReviewed, nextReview: r.data.document.nextReview }); setMsg("Marked as reviewed today."); } else setErr(r.data.error ?? "Failed");
  }
  async function restore(v: number) {
    if (!window.confirm(`Restore version ${v}? The current text stays in the history.`)) return;
    const r = await api<{ document?: Doc; error?: string }>(`documents/${doc.id}/restore`, "POST", { version: v });
    if (!r.ok || !r.data.document) { setErr(r.data.error ?? "Could not restore"); return; }
    setDoc(r.data.document); setTitle(r.data.document.title); setBody(r.data.document.body ?? ""); setMsg(`Restored version ${v}.`);
  }
  async function remove() {
    if (!window.confirm("Delete this document and its history? This cannot be undone.")) return;
    const r = await api(`documents/${doc.id}`, "DELETE");
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full page load is intended
    if (r.ok) window.location.href = "/app/t/sops"; else setErr("Could not delete");
  }
  function print() {
    const w = window.open("", "_blank");
    if (!w) { setErr("Pop-up blocked. Allow pop-ups to print."); return; }
    w.document.write(exportHtml(title, body));
    w.document.close();
    w.focus();
    w.print();
  }
  async function toTasks() {
    setTaskMsg(undefined);
    const steps = extractSteps(body);
    if (steps.length === 0) { setTaskMsg("No steps found. Add a numbered Procedure list first."); return; }
    try {
      const r = await fetch("/api/tools/tasks/from-source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: { tool: "sops", id: doc.id }, title, items: steps.map((s) => ({ title: s })) }) });
      if (r.status === 404) setTaskMsg("Tasks tool not available yet.");
      else if (!r.ok) setTaskMsg((await r.json().catch(() => ({}))).error ?? "Could not create tasks");
      else setTaskMsg(`Created ${steps.length} task${steps.length === 1 ? "" : "s"}.`);
    } catch { setTaskMsg("Tasks tool not available yet."); }
  }
  const busy = job.state === "waiting" || job.state === "running";
  const missing = kind === "sop" ? missingSections(body) : [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <a href="/app/t/sops" className="text-sm text-slate-400 underline">All documents</a>
      <div className="grid gap-3 md:grid-cols-4">
        <label className="block text-sm md:col-span-2">Title<input className={input} disabled={!canWrite} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="block text-sm">Kind
          <select className={input} disabled={!canWrite} value={kind} onChange={(e) => setKind(e.target.value)}>{DOC_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
        </label>
        <label className="block text-sm">Status
          <select className={input} disabled={!canWrite} value={status} onChange={(e) => setStatus(e.target.value as Doc["status"])}><option value="draft">Draft</option><option value="active">Active</option><option value="archived">Archived</option></select>
        </label>
        <label className="block text-sm">Review
          <select className={input} disabled={!canWrite} value={freq} onChange={(e) => setFreq(e.target.value as Doc["reviewFrequency"])}><option value="none">No review cycle</option><option value="quarterly">Every quarter</option><option value="yearly">Every year</option></select>
        </label>
        <p className="text-xs text-slate-400 md:col-span-3">Version {doc.version}. Last reviewed: {doc.lastReviewed ?? "never"}.{doc.nextReview && ` Next review: ${doc.nextReview}.`}</p>
      </div>
      {missing.length > 0 && body.trim() && <p className="text-xs text-slate-500">Standard SOP sections not found: {missing.join(", ")}.</p>}
      {aiShown && <p className="text-xs font-medium text-amber-300">AI draft, review before use. It is not saved until you press Save.</p>}
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">Markdown
          <textarea className={`${input} h-[28rem] font-mono text-xs`} readOnly={!canWrite} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div><div className="mb-1 text-sm">Preview</div><div className="h-[28rem] overflow-auto rounded-lg border border-slate-800 bg-slate-900 p-3"><Preview markdown={body} /></div></div>
      </div>
      {canWrite && (
        <div className="flex flex-wrap items-center gap-2">
          <input className={`${input} max-w-xs`} placeholder="What changed? (optional)" aria-label="Change note" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className={btn} disabled={!dirty || !title.trim()} onClick={save}>Save</button>
          <button className={btn2} onClick={reviewed}>Mark reviewed today</button>
          <button className={btn2} onClick={remove}>Delete</button>
        </div>
      )}
      {msg && <p className="text-sm text-emerald-300" role="status">{msg}</p>}
      {err && <p className="text-sm text-red-300" role="alert">{err}</p>}

      <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Export and actions">
        <h2 className="text-sm font-medium">Export and actions</h2>
        <div className="flex flex-wrap gap-2">
          <button className={btn2} onClick={() => download(`${fileName(title)}.md`, body, "text/markdown")}>Download .md</button>
          <button className={btn2} onClick={() => download(`${fileName(title)}.doc`, exportHtml(title, body), "application/msword")}>Download for Word (.doc)</button>
          <button className={btn2} onClick={print}>Print / save as PDF</button>
          <button className={btn2} onClick={() => { setBody(toChecklist(title, body)); setKind("checklist"); setMsg("Converted to a checklist below. Press Save to keep it."); }} disabled={!canWrite}>Turn into a checklist</button>
          <button className={btn2} onClick={toTasks} disabled={!canWrite}>Create tasks from these steps</button>
        </div>
        {taskMsg && <p className="text-sm text-slate-300" role="status">{taskMsg}</p>}
        <p className="text-xs text-slate-500">The Word file is HTML that Word opens; no DOCX library is used.</p>
      </section>

      {canWrite && (
        <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="AI help">
          <h2 className="text-sm font-medium">AI help (optional)</h2>
          <div className="flex flex-wrap gap-2">
            {kind === "sop" ? (
              <>
                <button className={btn2} disabled={!aiAvailable || busy || !body.trim()} onClick={() => start({ action: "improve", body })}>Improve this SOP</button>
                <button className={btn2} disabled={!aiAvailable || busy || !body.trim()} onClick={() => start({ action: "expand", body })}>Expand this SOP</button>
              </>
            ) : <button className={btn2} disabled={!aiAvailable || busy || !body.trim()} onClick={() => start({ action: "polish", body, kind })}>Polish wording</button>}
          </div>
          {!aiAvailable && <p className="text-xs text-slate-500">AI is not available right now.</p>}
          <JobStatus job={job} />
        </section>
      )}

      <section className="rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Revision history">
        <h2 className="text-sm font-medium">Revision history</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {versions.map((v) => (
            <li key={v.version} className="flex items-center justify-between gap-2">
              <span>v{v.version} <span className="text-slate-500">{new Date(v.createdAt).toLocaleString()}{v.note ? `, ${v.note}` : ""}</span></span>
              {canWrite && v.version !== doc.version && <button className="text-xs underline" onClick={() => restore(v.version)}>Restore</button>}
            </li>
          ))}
        </ul>
      </section>
      <LinkedItems tool="sops" id={doc.id} canWrite={canWrite} />
    </div>
  );
}
