"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LinkedItems } from "@founderos/sdk/ui";
import { CONTACT_STATUSES, CONTACT_TYPES, formatUsd, STAGES, STAGE_LABELS, type Stage } from "../logic";
import type { Contact, Opportunity, TimelineEntry } from "../data";

/* ---------------------------------------------------------------- helpers */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- API payloads are untyped JSON
interface Res { ok: boolean; status: number; data: any }
async function api(method: string, path: string, body?: unknown): Promise<Res> {
  try {
    const r = await fetch(`/api/tools/crm/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) };
  } catch {
    return { ok: false, status: 0, data: { error: "Could not reach the server" } };
  }
}

const input = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500";
const btn = "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm hover:bg-slate-700 disabled:opacity-50";
const btnPrimary = "rounded-lg bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50";
const card = "rounded-xl border border-slate-800 bg-slate-900 p-4";

const cents = (v: string): number | null => {
  const n = Number(v.replace(/[$,\s]/g, ""));
  return v.trim() === "" ? 0 : Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
const dollars = (c: number) => (c / 100).toString();
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const stageLabel = (s: string | null | undefined) => (s ? (STAGE_LABELS[s as Stage] ?? s) : "");

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-slate-400">{label}</span>
      {children}
    </label>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-lg border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">{children}</p>;
}

/* --------------------------------------------------- follow-up task button */

function FollowUpButton({ id, title, canWrite }: { id: string; title: string; canWrite: boolean }) {
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string }>();
  const [busy, setBusy] = useState(false);
  if (!canWrite) return null;
  async function create() {
    setBusy(true);
    setMsg(undefined);
    try {
      const r = await fetch("/api/tools/tasks/from-source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `Follow up: ${title}`, sourceRef: { tool: "crm", id } }),
      });
      if (r.status === 404) setMsg({ kind: "err", text: "Tasks tool not available yet" });
      else if (!r.ok) setMsg({ kind: "err", text: (await r.json().catch(() => ({}))).error ?? "Could not create the task" });
      else setMsg({ kind: "ok", text: "Follow-up task created" });
    } catch {
      setMsg({ kind: "err", text: "Could not reach the server" });
    }
    setBusy(false);
  }
  return (
    <div>
      <button className={btn} onClick={create} disabled={busy}>Create follow-up task</button>
      {msg && <p role={msg.kind === "err" ? "alert" : "status"} className={`mt-1 text-xs ${msg.kind === "err" ? "text-amber-300" : "text-emerald-300"}`}>{msg.text}{msg.kind === "ok" && <> <a className="underline" href="/app/t/tasks">Open tasks</a></>}</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- contacts */

const blank = { name: "", company: "", email: "", phone: "", type: "lead", source: "", tags: "", notes: "" };

export function ContactsView({ initial, canWrite }: { initial: Contact[]; canWrite: boolean }) {
  const [contacts, setContacts] = useState(initial);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const first = useRef(true);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (type) p.set("type", type);
    const r = await api("GET", `contacts?${p}`);
    if (r.ok) setContacts(r.data.contacts);
  }, [q, type]);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => void load(), 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Contacts</h1>
          <p className="text-sm text-slate-400">{contacts.length} shown</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite && <button className={btnPrimary} onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? "Close" : "Add contact"}</button>}
          {canWrite && <button className={btn} onClick={() => setImporting(!importing)} aria-expanded={importing}>Import CSV</button>}
          <a className={btn} href="/api/tools/crm/contacts/export" download="contacts.csv">Export CSV</a>
        </div>
      </div>

      {adding && canWrite && <AddContact onDone={() => { setAdding(false); void load(); }} />}
      {importing && canWrite && <ImportCsv onDone={() => void load()} />}

      <div className="flex flex-col gap-2 sm:flex-row">
        <input className={input} type="search" aria-label="Search contacts" placeholder="Search name, company, email, notes" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className={`${input} sm:w-48`} aria-label="Filter by type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All types</option>
          {CONTACT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {contacts.length === 0 ? (
        <p className={`${card} text-sm text-slate-400`}>No contacts yet. Add one, or import a CSV with the columns name, company, email, phone, type, tags.</p>
      ) : (
        <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900">
          {contacts.map((c) => (
            <li key={c.id}>
              <a href={`/app/t/crm/contacts/${c.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-slate-800/60">
                <span>
                  <span className="font-medium">{c.name}</span>
                  {c.company && <span className="ml-2 text-sm text-slate-400">{c.company}</span>}
                  {c.status === "inactive" && <span className="ml-2 text-xs text-slate-500">(inactive)</span>}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="rounded-full border border-slate-700 px-2 py-0.5">{c.type}</span>
                  {c.tags.slice(0, 3).map((t) => <span key={t} className="rounded-full bg-slate-800 px-2 py-0.5">{t}</span>)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddContact({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState(blank);
  const [error, setError] = useState<string>();
  const [dupes, setDupes] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof blank) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function checkEmail() {
    if (!f.email.trim()) { setDupes([]); return; }
    const r = await api("GET", `duplicates?email=${encodeURIComponent(f.email.trim())}`);
    if (r.ok) setDupes(r.data.duplicates);
  }
  async function submit(e: FormEvent, allowDuplicate = false) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    const r = await api("POST", "contacts", { ...f, tags: f.tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean), allowDuplicate });
    setBusy(false);
    if (r.status === 409) { setDupes(r.data.duplicates); setError("A contact with this email already exists."); return; }
    if (!r.ok) { setError(r.data?.error ?? "Could not save"); return; }
    onDone();
  }

  return (
    <form className={`${card} space-y-3`} onSubmit={submit} aria-label="Add contact">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name *"><input className={input} required maxLength={200} value={f.name} onChange={set("name")} /></Field>
        <Field label="Company"><input className={input} maxLength={200} value={f.company} onChange={set("company")} /></Field>
        <Field label="Email"><input className={input} type="email" value={f.email} onChange={set("email")} onBlur={checkEmail} /></Field>
        <Field label="Phone"><input className={input} type="tel" value={f.phone} onChange={set("phone")} /></Field>
        <Field label="Type">
          <select className={input} value={f.type} onChange={set("type")}>{CONTACT_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Source"><input className={input} value={f.source} onChange={set("source")} placeholder="Referral, website, event" /></Field>
        <Field label="Tags (comma separated)"><input className={input} value={f.tags} onChange={set("tags")} /></Field>
        <Field label="Notes"><input className={input} value={f.notes} onChange={set("notes")} /></Field>
      </div>
      {dupes.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          This email is already used by{" "}
          {dupes.map((d, i) => <span key={d.id}>{i > 0 && ", "}<a className="underline" href={`/app/t/crm/contacts/${d.id}`}>{d.name}</a></span>)}.
          <button type="button" className="ml-2 underline" onClick={(e) => submit(e as unknown as FormEvent, true)}>Add anyway</button>
        </div>
      )}
      {error && dupes.length === 0 && <Alert>{error}</Alert>}
      <button className={btnPrimary} disabled={busy}>Save contact</button>
    </form>
  );
}

function ImportCsv({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; errors: { line: number; error: string }[] }>();
  const [error, setError] = useState<string>();

  async function run(allowDuplicates: boolean) {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    const r = await api("POST", "contacts/import", { csv: text, allowDuplicates });
    setBusy(false);
    if (!r.ok) { setError(r.data?.error ?? "Import failed"); return; }
    setResult(r.data);
    if (r.data.created > 0) onDone();
  }

  return (
    <section className={`${card} space-y-3`} aria-label="Import contacts from CSV">
      <p className="text-sm text-slate-300">Columns: <code>name</code> (required), <code>company</code>, <code>email</code>, <code>phone</code>, <code>type</code> ({CONTACT_TYPES.join(", ")}), <code>tags</code> (separated by semicolons). Valid rows are imported; rows with problems are listed below. Contacts whose email already exists are skipped.</p>
      <input type="file" accept=".csv,text/csv" aria-label="Choose a CSV file" className="block text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
      <textarea className={`${input} h-32 font-mono`} aria-label="CSV text" placeholder={"name,company,email,phone,type,tags\nAda Lovelace,Analytical Co,ada@example.com,555-0100,customer,vip;referral"} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex gap-2">
        <button className={btnPrimary} disabled={busy || !text.trim()} onClick={() => run(false)}>Import</button>
        {result && result.errors.some((e) => /already exists/.test(e.error)) && <button className={btn} disabled={busy} onClick={() => run(true)}>Import again including duplicates</button>}
      </div>
      {error && <Alert>{error}</Alert>}
      {result && (
        <div role="status" className="space-y-2 text-sm">
          <p className="text-emerald-300">{result.created} contacts imported. {result.errors.length > 0 && <span className="text-amber-300">{result.errors.length} rows skipped.</span>}</p>
          {result.errors.length > 0 && (
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Rows that were not imported</caption>
              <thead><tr className="text-slate-400"><th className="py-1 pr-3">Line</th><th>Problem</th></tr></thead>
              <tbody>{result.errors.map((e) => <tr key={e.line} className="border-t border-slate-800"><td className="py-1 pr-3">{e.line}</td><td>{e.error}</td></tr>)}</tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- timeline */

function Timeline({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) return <p className="text-sm text-slate-500">Nothing yet. Add a note to start the timeline.</p>;
  return (
    <ol className="space-y-3">
      {entries.map((e, i) => (
        <li key={i} className="border-l-2 border-slate-700 pl-3 text-sm">
          <div className="text-xs text-slate-500">{when(e.at)}{e.opportunityTitle && <> · {e.opportunityId ? <a className="underline" href={`/app/t/crm/opportunities/${e.opportunityId}`}>{e.opportunityTitle}</a> : e.opportunityTitle}</>}</div>
          {e.kind === "note" ? <p className="whitespace-pre-wrap">{e.body}</p> : <p>{e.fromStage ? `Moved from ${stageLabel(e.fromStage)} to ${stageLabel(e.toStage)}` : `Opened as ${stageLabel(e.toStage)}`}</p>}
        </li>
      ))}
    </ol>
  );
}

function NoteForm({ path, canWrite, onSaved }: { path: string; canWrite: boolean; onSaved: (t: TimelineEntry[]) => void }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  if (!canWrite) return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await api("POST", path, { body });
    if (!r.ok) { setError(r.data?.error ?? "Could not save the note"); return; }
    setBody("");
    setError(undefined);
    onSaved(r.data.timeline);
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <Field label="Add a note"><textarea className={`${input} h-20`} required maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      {error && <Alert>{error}</Alert>}
      <button className={btn} disabled={!body.trim()}>Save note</button>
    </form>
  );
}

/* ---------------------------------------------------------- contact detail */

export function ContactDetail({ contact: initial, opportunities: initialOpps, timeline: initialTl, canWrite }: { contact: Contact; opportunities: Opportunity[]; timeline: TimelineEntry[]; canWrite: boolean }) {
  const [contact, setContact] = useState(initial);
  const [opps, setOpps] = useState(initialOpps);
  const [tl, setTl] = useState(initialTl);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();

  const reload = useCallback(async () => {
    const r = await api("GET", `contacts/${contact.id}`);
    if (r.ok) { setContact(r.data.contact); setOpps(r.data.opportunities); setTl(r.data.timeline); }
  }, [contact.id]);

  async function remove() {
    if (!window.confirm(`Delete ${contact.name} and their opportunities and notes? This cannot be undone.`)) return;
    const r = await api("DELETE", `contacts/${contact.id}`);
    if (r.ok) window.location.href = "/app/t/crm";
    else setError(r.data?.error ?? "Could not delete");
  }

  return (
    <div className="space-y-4">
      <p className="text-sm"><a className="text-slate-400 underline" href="/app/t/crm">All contacts</a></p>
      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{contact.name}</h1>
            <p className="text-sm text-slate-400">{[contact.company, contact.type, contact.status].filter(Boolean).join(" · ")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <FollowUpButton id={contact.id} title={contact.name} canWrite={canWrite} />
            {canWrite && <button className={btn} onClick={() => setEditing(!editing)} aria-expanded={editing}>{editing ? "Cancel" : "Edit"}</button>}
            {canWrite && <button className={btn} onClick={remove}>Delete</button>}
          </div>
        </div>
        {error && <Alert>{error}</Alert>}
        {editing ? (
          <EditContact contact={contact} onSaved={() => { setEditing(false); void reload(); }} />
        ) : (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            {contact.email && <div><dt className="text-xs text-slate-500">Email</dt><dd><a className="underline" href={`mailto:${contact.email}`}>{contact.email}</a></dd></div>}
            {contact.phone && <div><dt className="text-xs text-slate-500">Phone</dt><dd><a className="underline" href={`tel:${contact.phone}`}>{contact.phone}</a></dd></div>}
            {contact.source && <div><dt className="text-xs text-slate-500">Source</dt><dd>{contact.source}</dd></div>}
            {contact.tags.length > 0 && <div><dt className="text-xs text-slate-500">Tags</dt><dd>{contact.tags.join(", ")}</dd></div>}
            {contact.notes && <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Notes</dt><dd className="whitespace-pre-wrap">{contact.notes}</dd></div>}
            <div><dt className="text-xs text-slate-500">Last activity</dt><dd>{when(contact.lastActivityAt)}</dd></div>
          </dl>
        )}
      </div>

      <section className={`${card} space-y-3`} aria-label="Opportunities">
        <h2 className="text-sm font-medium">Opportunities</h2>
        {opps.length === 0 && <p className="text-sm text-slate-500">No opportunities yet.</p>}
        <ul className="space-y-1">
          {opps.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <a className="underline" href={`/app/t/crm/opportunities/${o.id}`}>{o.title}</a>
              <span className="text-slate-400">{stageLabel(o.stage)} · {formatUsd(o.valueCents)}</span>
            </li>
          ))}
        </ul>
        {canWrite && <NewOpportunity contactId={contact.id} onCreated={() => void reload()} />}
      </section>

      <section className={`${card} space-y-4`} aria-label="Timeline">
        <h2 className="text-sm font-medium">Timeline</h2>
        <NoteForm path={`contacts/${contact.id}/notes`} canWrite={canWrite} onSaved={(t) => { setTl(t); void reload(); }} />
        <Timeline entries={tl} />
      </section>

      <LinkedItems tool="crm" id={contact.id} canWrite={canWrite} />
    </div>
  );
}

function EditContact({ contact, onSaved }: { contact: Contact; onSaved: () => void }) {
  const [f, setF] = useState({ name: contact.name, company: contact.company, email: contact.email, phone: contact.phone, type: contact.type, status: contact.status, source: contact.source, tags: contact.tags.join(", "), notes: contact.notes });
  const [error, setError] = useState<string>();
  const [dupes, setDupes] = useState<{ id: string; name: string }[]>([]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent | null, allowDuplicate = false) {
    e?.preventDefault();
    const r = await api("PATCH", `contacts/${contact.id}`, { ...f, tags: f.tags.split(/[;,]/).map((t) => t.trim()).filter(Boolean), allowDuplicate });
    if (r.status === 409) { setDupes(r.data.duplicates); return; }
    if (!r.ok) { setError(r.data?.error ?? "Could not save"); return; }
    onSaved();
  }
  return (
    <form onSubmit={(e) => submit(e)} className="space-y-3" aria-label="Edit contact">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className={input} required value={f.name} onChange={set("name")} /></Field>
        <Field label="Company"><input className={input} value={f.company} onChange={set("company")} /></Field>
        <Field label="Email"><input className={input} type="email" value={f.email} onChange={set("email")} /></Field>
        <Field label="Phone"><input className={input} type="tel" value={f.phone} onChange={set("phone")} /></Field>
        <Field label="Type"><select className={input} value={f.type} onChange={set("type")}>{CONTACT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Status"><select className={input} value={f.status} onChange={set("status")}>{CONTACT_STATUSES.map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Source"><input className={input} value={f.source} onChange={set("source")} /></Field>
        <Field label="Tags (comma separated)"><input className={input} value={f.tags} onChange={set("tags")} /></Field>
        <div className="sm:col-span-2"><Field label="Notes"><textarea className={`${input} h-20`} value={f.notes} onChange={set("notes")} /></Field></div>
      </div>
      {dupes.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          This email is already used by {dupes.map((d) => d.name).join(", ")}.
          <button type="button" className="ml-2 underline" onClick={() => submit(null, true)}>Save anyway</button>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      <button className={btnPrimary}>Save changes</button>
    </form>
  );
}

function NewOpportunity({ contactId, onCreated }: { contactId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [close, setClose] = useState("");
  const [error, setError] = useState<string>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const valueCents = cents(value);
    if (valueCents == null) { setError("Enter the value as a number"); return; }
    const r = await api("POST", "opportunities", { contactId, title, valueCents, expectedClose: close || null });
    if (!r.ok) { setError(r.data?.error ?? "Could not save"); return; }
    setOpen(false); setTitle(""); setValue(""); setClose(""); setError(undefined);
    onCreated();
  }
  if (!open) return <button className={btn} onClick={() => setOpen(true)}>Add opportunity</button>;
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Add opportunity">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Title *"><input className={input} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Value (USD)"><input className={input} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        <Field label="Expected close"><input className={input} type="date" value={close} onChange={(e) => setClose(e.target.value)} /></Field>
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="flex gap-2"><button className={btnPrimary}>Save opportunity</button><button type="button" className={btn} onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

/* ------------------------------------------------------ opportunity detail */

async function moveStage(oppId: string, stage: Stage): Promise<Res | null> {
  let lostReason: string | undefined;
  if (stage === "lost") {
    const reason = window.prompt("Why was this opportunity lost?");
    if (!reason?.trim()) return null;
    lostReason = reason.trim();
  }
  return api("POST", `opportunities/${oppId}/stage`, { stage, lostReason });
}

export function OpportunityDetail({ opportunity: initial, timeline: initialTl, canWrite }: { opportunity: Opportunity; timeline: TimelineEntry[]; canWrite: boolean }) {
  const [opp, setOpp] = useState(initial);
  const [tl, setTl] = useState(initialTl);
  const [error, setError] = useState<string>();
  const [edit, setEdit] = useState({ title: initial.title, value: dollars(initial.valueCents), close: initial.expectedClose ?? "", owner: initial.owner });

  const reload = useCallback(async () => {
    const r = await api("GET", `opportunities/${opp.id}`);
    if (r.ok) { setOpp(r.data.opportunity); setTl(r.data.timeline); }
  }, [opp.id]);

  async function stage(s: Stage) {
    setError(undefined);
    const r = await moveStage(opp.id, s);
    if (!r) return;
    if (!r.ok) { setError(r.data?.error ?? "Could not move"); return; }
    await reload();
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const valueCents = cents(edit.value);
    if (valueCents == null) { setError("Enter the value as a number"); return; }
    const r = await api("PATCH", `opportunities/${opp.id}`, { title: edit.title, valueCents, expectedClose: edit.close || null, owner: edit.owner });
    if (!r.ok) { setError(r.data?.error ?? "Could not save"); return; }
    setError(undefined);
    await reload();
  }

  return (
    <div className="space-y-4">
      <p className="text-sm"><a className="text-slate-400 underline" href="/app/t/crm/pipeline">Pipeline</a> / <a className="text-slate-400 underline" href={`/app/t/crm/contacts/${opp.contactId}`}>{opp.contactName}</a></p>
      <div className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{opp.title}</h1>
            <p className="text-sm text-slate-400">{stageLabel(opp.stage)} · {formatUsd(opp.valueCents)}{opp.expectedClose && ` · expected close ${opp.expectedClose}`}</p>
            {opp.stage === "lost" && opp.lostReason && <p className="text-sm text-slate-400">Lost because: {opp.lostReason}</p>}
          </div>
          <FollowUpButton id={opp.contactId} title={opp.contactName} canWrite={canWrite} />
        </div>
        {canWrite && (
          <div role="group" aria-label="Move to stage" className="flex flex-wrap gap-2">
            {STAGES.map((s) => <button key={s} className={`${btn} ${s === opp.stage ? "!border-sky-500 !bg-sky-900/50" : ""}`} aria-pressed={s === opp.stage} onClick={() => stage(s)}>{STAGE_LABELS[s]}</button>)}
          </div>
        )}
        {error && <Alert>{error}</Alert>}
        {canWrite && (
          <form onSubmit={save} className="grid gap-3 sm:grid-cols-4" aria-label="Edit opportunity">
            <Field label="Title"><input className={input} required value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Value (USD)"><input className={input} inputMode="decimal" value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></Field>
            <Field label="Expected close"><input className={input} type="date" value={edit.close} onChange={(e) => setEdit({ ...edit, close: e.target.value })} /></Field>
            <Field label="Owner"><input className={input} value={edit.owner} onChange={(e) => setEdit({ ...edit, owner: e.target.value })} /></Field>
            <div className="sm:col-span-4"><button className={btn}>Save changes</button></div>
          </form>
        )}
      </div>
      <section className={`${card} space-y-4`} aria-label="Timeline">
        <h2 className="text-sm font-medium">Timeline</h2>
        <NoteForm path={`opportunities/${opp.id}/notes`} canWrite={canWrite} onSaved={(t) => { setTl(t); void reload(); }} />
        <Timeline entries={tl} />
      </section>
      <LinkedItems tool="crm" id={opp.id} canWrite={canWrite} />
    </div>
  );
}

/* ---------------------------------------------------------------- pipeline */

type PipelineData = {
  staleDays: number;
  columns: { stage: Stage; count: number; totalCents: number; items: (Opportunity & { stale: boolean; pastClose: boolean })[] }[];
  stats: { stages: { stage: Stage; reached: number; avgDaysInStage: number | null }[]; won: number; lost: number; winRatePct: number | null };
};

export function PipelineView({ initial, canWrite }: { initial: PipelineData; canWrite: boolean }) {
  const [data, setData] = useState(initial);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [contacts, setContacts] = useState<{ id: string; name: string }[]>([]);

  const reload = useCallback(async () => {
    const r = await api("GET", "pipeline");
    if (r.ok) setData(r.data);
  }, []);

  async function openAdd() {
    setAdding(!adding);
    if (contacts.length === 0) {
      const r = await api("GET", "contacts");
      if (r.ok) setContacts(r.data.contacts.map((c: Contact) => ({ id: c.id, name: c.company ? `${c.name} (${c.company})` : c.name })));
    }
  }
  async function move(o: Opportunity, stage: Stage) {
    setError(undefined);
    const r = await moveStage(o.id, stage);
    if (!r) return;
    if (!r.ok) { setError(r.data?.error ?? "Could not move"); return; }
    await reload();
  }

  const open = data.columns.filter((c) => c.stage !== "won" && c.stage !== "lost");
  const openTotal = open.reduce((s, c) => s + c.totalCents, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Pipeline</h1>
          <p className="text-sm text-slate-400">Open deals {formatUsd(openTotal)} · flagged stale after {data.staleDays} days without activity</p>
        </div>
        {canWrite && <button className={btnPrimary} onClick={openAdd} aria-expanded={adding}>{adding ? "Close" : "Add opportunity"}</button>}
      </div>
      {adding && canWrite && (
        <PipelineAdd contacts={contacts} onCreated={() => { setAdding(false); void reload(); }} />
      )}
      {error && <Alert>{error}</Alert>}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {data.columns.map((col) => (
          <section key={col.stage} aria-label={`${STAGE_LABELS[col.stage]} stage`} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
            <header className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-medium">{STAGE_LABELS[col.stage]}</h2>
              <span className="text-xs text-slate-400">{col.count} · {formatUsd(col.totalCents)}</span>
            </header>
            {col.items.length === 0 && <p className="text-xs text-slate-600">Empty</p>}
            <ul className="space-y-2">
              {col.items.map((o) => (
                <li key={o.id} className="rounded-lg border border-slate-800 bg-slate-950 p-2 text-sm">
                  <a className="font-medium underline" href={`/app/t/crm/opportunities/${o.id}`}>{o.title}</a>
                  <div className="text-xs text-slate-400">{o.contactName} · {formatUsd(o.valueCents)}</div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
                    {o.stale && <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-200">Stale</span>}
                    {o.pastClose && <span className="rounded bg-red-900/50 px-1.5 py-0.5 text-red-200">Past close date</span>}
                    {o.expectedClose && <span className="text-slate-500">close {o.expectedClose}</span>}
                  </div>
                  {canWrite && (
                    <select className="mt-2 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs" aria-label={`Move ${o.title} to stage`} value={o.stage} onChange={(e) => move(o, e.target.value as Stage)}>
                      {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                    </select>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <section className={card} aria-label="Pipeline statistics">
        <h2 className="text-sm font-medium">How deals move</h2>
        <p className="mt-1 text-sm text-slate-400">
          {data.stats.winRatePct == null ? "No closed deals yet, so no win rate." : `Win rate ${data.stats.winRatePct}% (${data.stats.won} won, ${data.stats.lost} lost).`}
        </p>
        <table className="mt-2 w-full text-left text-sm">
          <caption className="sr-only">Time in each stage</caption>
          <thead><tr className="text-xs text-slate-500"><th className="py-1">Stage</th><th>Deals that reached it</th><th>Average days in stage</th></tr></thead>
          <tbody>
            {data.stats.stages.map((s) => (
              <tr key={s.stage} className="border-t border-slate-800">
                <td className="py-1">{STAGE_LABELS[s.stage]}</td><td>{s.reached}</td><td>{s.avgDaysInStage == null ? "n/a" : s.avgDaysInStage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function PipelineAdd({ contacts, onCreated }: { contacts: { id: string; name: string }[]; onCreated: () => void }) {
  const [contactId, setContactId] = useState("");
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [close, setClose] = useState("");
  const [error, setError] = useState<string>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const valueCents = cents(value);
    if (valueCents == null) { setError("Enter the value as a number"); return; }
    const r = await api("POST", "opportunities", { contactId, title, valueCents, expectedClose: close || null });
    if (!r.ok) { setError(r.data?.error ?? "Could not save"); return; }
    onCreated();
  }
  return (
    <form onSubmit={submit} className={`${card} space-y-3`} aria-label="Add opportunity">
      {contacts.length === 0 && <p className="text-sm text-slate-400">Add a contact first; every opportunity belongs to a contact.</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Contact *">
          <select className={input} required value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">Choose…</option>
            {contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Title *"><input className={input} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Value (USD)"><input className={input} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        <Field label="Expected close"><input className={input} type="date" value={close} onChange={(e) => setClose(e.target.value)} /></Field>
      </div>
      {error && <Alert>{error}</Alert>}
      <button className={btnPrimary}>Save opportunity</button>
    </form>
  );
}
