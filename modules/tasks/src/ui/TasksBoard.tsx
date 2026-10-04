"use client";
import { useMemo, useState } from "react";
import { LinkedItems } from "@founderos/sdk/ui";

export interface TaskDto {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done";
  priority: "low" | "medium" | "high";
  dueDate: string | null;
  assignedTo: string | null;
  source: string;
  sourceRef: { tool: string; id: string } | null;
  recurrence: "none" | "weekly" | "monthly" | "quarterly" | "yearly";
  completedAt: string | null;
}

const BASE = "/api/tools/tasks";

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? "Something went wrong");
  return data;
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const PRIORITY_STYLE: Record<string, string> = {
  high: "border-red-500/40 bg-red-500/10 text-red-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  low: "border-slate-600 bg-slate-800 text-slate-300",
};
const NEXT_PRIORITY = { low: "medium", medium: "high", high: "low" } as const;
const SOURCE_LABEL: Record<string, string> = { ai: "AI", compliance: "Compliance", document: "Documents", crm: "CRM", finance: "Finance", system: "System" };

export default function TasksBoard({ initial, today: serverToday, canWrite, userId, openId }: { initial: TaskDto[]; today: string; canWrite: boolean; userId: string; openId?: string }) {
  const [tasks, setTasks] = useState(initial);
  const today = serverToday; // the same date the server uses for overdue and attention
  const [error, setError] = useState<string>();
  const [mine, setMine] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState<TaskDto["priority"]>("medium");
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => (mine ? tasks.filter((t) => t.assignedTo === userId) : tasks), [tasks, mine, userId]);
  const open = visible.filter((t) => t.status !== "done");
  const sections = [
    { key: "overdue", label: "Overdue", tone: "text-red-300", items: open.filter((t) => t.dueDate && t.dueDate < today) },
    { key: "today", label: "Today", tone: "text-sky-300", items: open.filter((t) => t.dueDate === today) },
    { key: "upcoming", label: "Upcoming", tone: "text-slate-200", items: open.filter((t) => !t.dueDate || t.dueDate > today) },
    { key: "done", label: "Done (last 30 days)", tone: "text-slate-400", items: visible.filter((t) => t.status === "done") },
  ];

  function replace(t: TaskDto, next?: TaskDto | null) {
    setTasks((cur) => {
      const list = cur.map((c) => (c.id === t.id ? t : c));
      return next ? [...list, next] : list;
    });
  }
  async function run(fn: () => Promise<void>) {
    setError(undefined);
    try { await fn(); } catch (e) { setError((e as Error).message); }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    await run(async () => {
      const d = await api("POST", "items", { title, priority, dueDate: due || null });
      setTasks((cur) => [...cur, d.task]);
      setTitle(""); setDue("");
    });
    setBusy(false);
  }
  const update = (t: TaskDto, patch: Record<string, unknown>) =>
    run(async () => {
      const d = await api("PATCH", `items/${t.id}`, patch);
      replace(d.task, d.next);
    });
  const toggle = (t: TaskDto) => update(t, { status: t.status === "done" ? "todo" : "done" });
  const remove = (t: TaskDto) =>
    run(async () => {
      if (!window.confirm(`Delete "${t.title}"?`)) return;
      await api("DELETE", `items/${t.id}`);
      setTasks((cur) => cur.filter((c) => c.id !== t.id));
    });

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 text-slate-100">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm text-slate-400">Your tasks, plus the ones other tools raise for you.</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Assigned to me
        </label>
      </header>

      {canWrite ? (
        <form onSubmit={add} className="flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900 p-3" aria-label="Quick add task">
          <label className="sr-only" htmlFor="new-task">New task</label>
          <input id="new-task" className="min-w-0 flex-1 basis-56 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Add a task and press Enter" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
          <label className="sr-only" htmlFor="new-due">Due date</label>
          <input id="new-due" type="date" className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm" value={due} onChange={(e) => setDue(e.target.value)} />
          <label className="sr-only" htmlFor="new-priority">Priority</label>
          <select id="new-priority" className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-sm" value={priority} onChange={(e) => setPriority(e.target.value as TaskDto["priority"])}>
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
          <button disabled={busy || !title.trim()} className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium disabled:opacity-50">Add</button>
        </form>
      ) : (
        <p className="text-sm text-slate-400">You have read-only access.</p>
      )}
      {error && <p role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-sm text-red-300">{error}</p>}

      {sections.map((s) => (
        <section key={s.key} aria-label={s.label}>
          <h2 className={`mb-2 text-sm font-medium uppercase tracking-wide ${s.tone}`}>{s.label} <span className="text-slate-500">({s.items.length})</span></h2>
          {s.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-slate-800 p-3 text-sm text-slate-500">{s.key === "done" ? "Nothing completed recently." : "Nothing here."}</p>
          ) : (
            <ul className="space-y-2">
              {s.items.map((t) => (
                <TaskRow key={t.id} t={t} today={today} canWrite={canWrite} userId={userId} startOpen={t.id === openId} onToggle={() => toggle(t)} onUpdate={(p) => update(t, p)} onDelete={() => remove(t)} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function TaskRow({ t, today, canWrite, userId, startOpen, onToggle, onUpdate, onDelete }: { t: TaskDto; today: string; canWrite: boolean; userId: string; startOpen: boolean; onToggle: () => void; onUpdate: (p: Record<string, unknown>) => void; onDelete: () => void }) {
  const [expanded, setExpanded] = useState(startOpen);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(t.title);
  const [desc, setDesc] = useState(t.description);
  const done = t.status === "done";
  const days = t.dueDate ? daysBetween(today, t.dueDate) : null;
  const dueTone = done ? "text-slate-500" : days == null ? "text-slate-500" : days < 0 ? "text-red-300" : days <= 3 ? "text-amber-300" : "text-slate-300";
  const dueText = t.dueDate == null ? "No date" : days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : days! < 0 ? `${-days!} days overdue` : t.dueDate;

  function saveTitle() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== t.title) onUpdate({ title: draft.trim() });
    else setDraft(t.title);
  }

  return (
    <li className="rounded-xl border border-slate-800 bg-slate-900 p-3">
      <div className="flex items-center gap-3">
        <input type="checkbox" aria-label={done ? `Reopen ${t.title}` : `Complete ${t.title}`} checked={done} disabled={!canWrite} onChange={onToggle} className="h-4 w-4" />
        <div className="min-w-0 flex-1">
          {editing && canWrite ? (
            <input autoFocus aria-label="Task title" className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm" value={draft} maxLength={300} onChange={(e) => setDraft(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => { if (e.key === "Enter") saveTitle(); if (e.key === "Escape") { setDraft(t.title); setEditing(false); } }} />
          ) : (
            <button type="button" className={`block max-w-full truncate text-left text-sm ${done ? "text-slate-500 line-through" : ""}`} onClick={() => canWrite && setEditing(true)} title={canWrite ? "Click to edit" : undefined}>{t.title}</button>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span className={dueTone}>{dueText}</span>
            <button type="button" disabled={!canWrite} aria-label={`Priority ${t.priority}. Change priority`} onClick={() => onUpdate({ priority: NEXT_PRIORITY[t.priority] })} className={`rounded-full border px-2 py-0.5 ${PRIORITY_STYLE[t.priority]}`}>{t.priority}</button>
            {t.status === "in_progress" && <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-sky-300">in progress</span>}
            {t.recurrence !== "none" && <span className="rounded-full border border-slate-600 px-2 py-0.5 text-slate-300">repeats {t.recurrence}</span>}
            {t.source !== "manual" && <span className="rounded-full border border-slate-600 px-2 py-0.5 text-slate-300">from {SOURCE_LABEL[t.source] ?? t.source}</span>}
            {t.assignedTo === userId && <span className="rounded-full border border-slate-600 px-2 py-0.5 text-slate-300">mine</span>}
          </div>
        </div>
        <button type="button" className="text-xs text-slate-400 underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Close" : "Details"}</button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 border-t border-slate-800 pt-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="text-xs text-slate-400">Due date
              <input type="date" disabled={!canWrite} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100" value={t.dueDate ?? ""} onChange={(e) => onUpdate({ dueDate: e.target.value || null })} />
            </label>
            <label className="text-xs text-slate-400">Status
              <select disabled={!canWrite} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100" value={t.status} onChange={(e) => onUpdate({ status: e.target.value })}>
                <option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option>
              </select>
            </label>
            <label className="text-xs text-slate-400">Repeats
              <select disabled={!canWrite} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100" value={t.recurrence} onChange={(e) => onUpdate({ recurrence: e.target.value })}>
                <option value="none">Never</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option>
              </select>
            </label>
            <label className="flex items-end gap-2 pb-1 text-xs text-slate-400">
              <input type="checkbox" disabled={!canWrite} checked={t.assignedTo === userId} onChange={(e) => onUpdate({ assignedTo: e.target.checked ? userId : null })} /> Assigned to me
            </label>
          </div>
          <label className="block text-xs text-slate-400">Notes
            <textarea disabled={!canWrite} rows={3} maxLength={5000} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100" value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== t.description && onUpdate({ description: desc })} />
          </label>
          <LinkedItems tool="tasks" id={t.id} canWrite={canWrite} />
          {canWrite && <button type="button" onClick={onDelete} className="text-xs text-red-300 underline">Delete task</button>}
        </div>
      )}
    </li>
  );
}
