"use client";
import { useState } from "react";
import { EMPTY_SOP, type SopInput } from "../sop";
import { FIELD_DEFS, KIND_LABEL, TEMPLATE_KINDS, type DocKind, type TemplateKind } from "../templates";
import { api, btn, btn2, input, JobStatus, Preview, useAiJob, type Doc } from "./shared";

type Tab = "docs" | "sop" | "template";

export default function SopsHome({ initial, canWrite, aiAvailable }: { initial: Doc[]; canWrite: boolean; aiAvailable: boolean }) {
  const [tab, setTab] = useState<Tab>("docs");
  const tabs: [Tab, string][] = [["docs", "Your documents"], ["sop", "SOP builder"], ["template", "Business documents"]];
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header>
        <p className="text-sm text-slate-400">Write down how your business runs. Forms and templates work without AI; AI drafting is optional and always needs your review.</p>
      </header>
      <div role="tablist" className="flex flex-wrap gap-2">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? "bg-slate-100 text-slate-900" : "border border-slate-700 text-slate-300"}`}>{label}</button>
        ))}
      </div>
      {tab === "docs" && <DocList docs={initial} />}
      {tab === "sop" && <SopBuilder canWrite={canWrite} aiAvailable={aiAvailable} />}
      {tab === "template" && <Templates canWrite={canWrite} aiAvailable={aiAvailable} />}
    </div>
  );
}

function DocList({ docs }: { docs: Doc[] }) {
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const shown = docs.filter((d) => (kind === "all" || d.kind === kind) && d.title.toLowerCase().includes(q.toLowerCase()));
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section className="space-y-3" aria-label="Documents">
      <div className="flex flex-wrap gap-2">
        <input className={`${input} max-w-xs`} placeholder="Filter by title" aria-label="Filter by title" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${input} max-w-[12rem]`} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="all">All kinds</option>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {docs.length === 0 && <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">No documents yet. Start with the SOP builder or a business document template.</p>}
      <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900">
        {shown.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
            <a href={`/app/t/sops/${d.id}`} className="font-medium underline">{d.title}</a>
            <span className="flex flex-wrap gap-2 text-xs text-slate-400">
              <span>{KIND_LABEL[d.kind as DocKind] ?? d.kind}</span><span>{d.status}</span><span>v{d.version}</span>
              {d.nextReview && d.status === "active" && <span className={d.nextReview < today ? "text-amber-300" : ""}>review {d.nextReview}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Draft({ title, setTitle, body, setBody, kind, canWrite, aiLabel }: { title: string; setTitle: (s: string) => void; body: string; setBody: (s: string) => void; kind: DocKind; canWrite: boolean; aiLabel: boolean }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string>();
  async function save() {
    setSaving(true); setErr(undefined);
    const r = await api<{ document?: { id: string }; error?: string }>("documents", "POST", { title, kind, body });
    setSaving(false);
    if (!r.ok || !r.data.document) { setErr(r.data.error ?? "Could not save"); return; }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full page load into the new document is intended
    window.location.href = `/app/t/sops/${r.data.document.id}`;
  }
  return (
    <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Draft">
      {aiLabel && <p className="text-xs font-medium text-amber-300">AI draft, review before use. Replace every [●PLACEHOLDER] with the real facts.</p>}
      <label className="block text-sm">Title<input className={input} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">Markdown<textarea className={`${input} h-80 font-mono text-xs`} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <div><div className="mb-1 text-sm">Preview</div><div className="h-80 overflow-auto rounded-lg border border-slate-800 p-3"><Preview markdown={body} /></div></div>
      </div>
      {canWrite ? <button className={btn} disabled={saving || !title.trim()} onClick={save}>{saving ? "Saving..." : "Save as a document"}</button> : <p className="text-xs text-slate-500">Your role cannot save documents.</p>}
      {err && <p className="text-sm text-red-300" role="alert">{err}</p>}
    </section>
  );
}

const SOP_FIELDS: { key: keyof SopInput; label: string; multiline?: boolean; hint?: string }[] = [
  { key: "name", label: "Process name" }, { key: "goal", label: "Goal: why does this process exist?", multiline: true },
  { key: "performer", label: "Who performs it" }, { key: "frequency", label: "How often (daily, per job, monthly...)" },
  { key: "tools", label: "Tools and inputs needed (one per line)", multiline: true }, { key: "inputs", label: "Information or materials to have ready (one per line)", multiline: true },
  { key: "prerequisites", label: "Prerequisites (one per line)", multiline: true }, { key: "steps", label: "Steps (one per line)", multiline: true },
  { key: "qualityChecks", label: "Quality checks (one per line)", multiline: true }, { key: "exceptions", label: "Exceptions: what can go differently? (one per line)", multiline: true },
  { key: "escalation", label: "Escalation: who to tell when it goes wrong", multiline: true }, { key: "result", label: "Expected result", multiline: true },
];

function SopBuilder({ canWrite, aiAvailable }: { canWrite: boolean; aiAvailable: boolean }) {
  const [f, setF] = useState<SopInput>(EMPTY_SOP);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [aiShown, setAiShown] = useState(false);
  const [err, setErr] = useState<string>();
  const { job, start, reset } = useAiJob((text) => { setBody(text); setAiShown(true); setTitle((t) => t || f.name || "New SOP"); });

  async function format() {
    setErr(undefined); reset();
    const r = await api<{ title: string; body: string; error?: string }>("sop/format", "POST", f);
    if (!r.ok) { setErr(r.data.error ?? "Could not format"); return; }
    setTitle(r.data.title); setBody(r.data.body); setAiShown(false);
  }
  const notes = Object.entries(f).filter(([k, v]) => v.trim() && k !== "name").map(([k, v]) => `${k}: ${v}`).join("\n");
  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="SOP builder">
        <p className="text-sm text-slate-400">Answer what you know; leave the rest blank. Blank parts become [●TO FILL IN] markers.</p>
        <div className="grid gap-3 md:grid-cols-2">
          {SOP_FIELDS.map((d) => (
            <label key={d.key} className="block text-sm">{d.label}
              {d.multiline ? <textarea className={`${input} h-20`} value={f[d.key]} onChange={(e) => setF({ ...f, [d.key]: e.target.value })} /> : <input className={input} value={f[d.key]} onChange={(e) => setF({ ...f, [d.key]: e.target.value })} />}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={format}>Build SOP (no AI)</button>
          <button className={btn2} disabled={!aiAvailable || !canWrite || !f.name.trim() || job.state === "waiting" || job.state === "running"} onClick={() => start({ action: "draft_sop", process: f.name, notes })}>Draft with AI</button>
          <button className={btn2} disabled={!aiAvailable || !canWrite || !body.trim() || job.state === "waiting" || job.state === "running"} onClick={() => start({ action: "improve", body })}>Improve current draft with AI</button>
          <button className={btn2} disabled={!aiAvailable || !canWrite || !body.trim() || job.state === "waiting" || job.state === "running"} onClick={() => start({ action: "expand", body })}>Expand with AI</button>
        </div>
        {!aiAvailable && <p className="text-xs text-slate-500">AI is not available right now; the form builder still works.</p>}
        <JobStatus job={job} />
        {err && <p className="text-sm text-red-300" role="alert">{err}</p>}
      </section>
      {body && <Draft title={title} setTitle={setTitle} body={body} setBody={setBody} kind="sop" canWrite={canWrite} aiLabel={aiShown} />}
    </div>
  );
}

function Templates({ canWrite, aiAvailable }: { canWrite: boolean; aiAvailable: boolean }) {
  const [kind, setKind] = useState<TemplateKind>("proposal");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [aiShown, setAiShown] = useState(false);
  const [err, setErr] = useState<string>();
  const { job, start, reset } = useAiJob((text) => { setBody(text); setAiShown(true); });

  async function generate() {
    setErr(undefined); reset();
    const r = await api<{ title: string; body: string; error?: string }>("generate", "POST", { kind, fields });
    if (!r.ok) { setErr(r.data.error ?? "Could not generate"); return; }
    setTitle(r.data.title); setBody(r.data.body); setAiShown(false);
  }
  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Document templates">
        <label className="block text-sm">Document type
          <select className={`${input} max-w-xs`} value={kind} onChange={(e) => { setKind(e.target.value as TemplateKind); setFields({}); setBody(""); }}>
            {TEMPLATE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        <p className="text-xs text-slate-500">Your business name, location and website are filled in automatically.</p>
        <div className="grid gap-3 md:grid-cols-2">
          {FIELD_DEFS[kind].map((d) => (
            <label key={d.key} className="block text-sm">{d.label}
              {d.multiline ? <textarea className={`${input} h-20`} placeholder={d.hint} value={fields[d.key] ?? ""} onChange={(e) => setFields({ ...fields, [d.key]: e.target.value })} /> : <input className={input} value={fields[d.key] ?? ""} onChange={(e) => setFields({ ...fields, [d.key]: e.target.value })} />}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={btn} onClick={generate}>Generate from template</button>
          <button className={btn2} disabled={!aiAvailable || !canWrite || !body.trim() || job.state === "waiting" || job.state === "running"} onClick={() => start({ action: "polish", body, kind })}>Polish with AI</button>
        </div>
        <JobStatus job={job} />
        {err && <p className="text-sm text-red-300" role="alert">{err}</p>}
      </section>
      {body && <Draft title={title} setTitle={setTitle} body={body} setBody={setBody} kind={kind} canWrite={canWrite} aiLabel={aiShown} />}
    </div>
  );
}
