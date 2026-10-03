"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface Conv { id: string; title: string; updatedAt: string }
interface Source { n: number; tool: string; toolName: string; title: string; href: string }
interface Action { label: string; href: string }
interface Msg {
  id: string; role: "user" | "assistant"; content: string; status: "pending" | "done" | "failed"; error: string | null;
  sources: Source[]; warnings: string[]; actions: Action[]; note: string | null; createdAt: string;
}

const QUICK = [
  "What should I work on this week?",
  "What am I missing before hiring a contractor?",
  "Summarize my business risks",
];
const DOCS_PREFIX = "What do my documents say about ";
const safeHref = (h: string) => h.startsWith("/app/") && !h.startsWith("//");

async function api<T>(path: string, method = "GET", body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const r = await fetch(`/api/tools/founderai/${path}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as T & { error?: string } };
}

function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
  return <span>{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}</span>;
}

export default function Chat({ initialConversations, initialId, aiAvailable }: { initialConversations: Conv[]; initialId?: string; aiAvailable: boolean }) {
  const [convs, setConvs] = useState(initialConversations);
  const [activeId, setActiveId] = useState<string | undefined>(initialId);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(async () => {
    const r = await api<{ conversations: Conv[] }>("conversations");
    if (r.ok) setConvs(r.data.conversations);
  }, []);

  const open = useCallback(async (id: string | undefined) => {
    setActiveId(id); setError(undefined); setMsgs([]);
    if (!id) return;
    const r = await api<{ messages: Msg[] }>(`conversations/${id}`);
    if (r.ok) setMsgs(r.data.messages); else setError(r.data.error ?? "Could not open this conversation");
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads the first conversation once on mount
  useEffect(() => { if (initialId) void open(initialId); }, [initialId, open]);

  // Poll every pending answer every 2 seconds.
  const pendingIds = msgs.filter((m) => m.role === "assistant" && m.status === "pending").map((m) => m.id).join(",");
  useEffect(() => {
    if (!pendingIds) return;
    const t = setInterval(async () => {
      for (const id of pendingIds.split(",")) {
        const r = await api<{ message: Msg }>(`messages/${id}`);
        if (r.ok) setMsgs((cur) => cur.map((m) => (m.id === id ? r.data.message : m)));
      }
    }, 2000);
    return () => clearInterval(t);
  }, [pendingIds]);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "end" }); }, [msgs.length, pendingIds]);

  async function ask(content: string) {
    const q = content.trim();
    if (!q || busy) return;
    setBusy(true); setError(undefined);
    const r = await api<{ conversation: Conv; userMessage: Msg; assistantMessage: Msg }>("messages", "POST", { conversationId: activeId, content: q });
    setBusy(false);
    if (!r.ok) { setError(r.data.error ?? "Could not send this question"); return; }
    setText("");
    setActiveId(r.data.conversation.id);
    setMsgs((cur) => [...cur, r.data.userMessage, r.data.assistantMessage]);
    void refreshList();
  }

  async function retry(id: string) {
    setError(undefined);
    const r = await api<{ message: Msg }>(`messages/${id}/retry`, "POST");
    if (!r.ok) { setError(r.data.error ?? "Could not retry"); return; }
    setMsgs((cur) => cur.map((m) => (m.id === id ? r.data.message : m)));
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    const r = await api<object>(`conversations/${id}`, "DELETE");
    if (!r.ok) { setError(r.data.error ?? "Could not delete"); return; }
    if (id === activeId) { setActiveId(undefined); setMsgs([]); }
    await refreshList();
  }

  const waitingForAnswer = pendingIds.length > 0;

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <aside className="rounded-xl border border-slate-800 bg-slate-900 p-3" aria-label="Conversations">
        <button className="mb-2 w-full rounded-lg bg-slate-100 px-3 py-2 text-sm font-medium text-slate-900" onClick={() => void open(undefined)}>New conversation</button>
        {convs.length === 0 && <p className="px-1 py-2 text-xs text-slate-500">No conversations yet. Only you can see yours.</p>}
        <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
          {convs.map((c) => (
            <li key={c.id} className={`group flex items-center justify-between rounded-lg px-2 py-1.5 text-sm ${c.id === activeId ? "bg-slate-800" : "hover:bg-slate-800/60"}`}>
              <button className="min-w-0 flex-1 truncate text-left" onClick={() => void open(c.id)} aria-current={c.id === activeId}>{c.title}</button>
              <button className="ml-2 text-xs text-slate-500 hover:text-red-300" aria-label={`Delete conversation ${c.title}`} onClick={() => void remove(c.id)}>Delete</button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-h-[60vh] flex-col rounded-xl border border-slate-800 bg-slate-900" aria-label="Chat">
        <div className="flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
          {msgs.length === 0 && (
            <div>
              <h2 className="text-lg font-medium">Ask FounderOS</h2>
              <p className="mt-1 text-sm text-slate-400">Answers use your business profile and what your tools know. It reads your data but never changes it, and it is not a lawyer, accountant or financial adviser.</p>
              {!aiAvailable && <p className="mt-3 rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200" role="status">AI is not set up for this business yet. You can still save questions and retry them later.</p>}
              <div className="mt-4 flex flex-wrap gap-2">
                {QUICK.map((q) => <button key={q} className="rounded-full border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800" onClick={() => void ask(q)}>{q}</button>)}
                <button className="rounded-full border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800" onClick={() => { setText(DOCS_PREFIX); input.current?.focus(); }}>{DOCS_PREFIX}…?</button>
              </div>
            </div>
          )}
          {msgs.map((m) => (
            <div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
              {m.role === "user" ? (
                <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-slate-700 px-4 py-2 text-sm">{m.content}</p>
              ) : (
                <div className="max-w-full space-y-2 text-sm">
                  {m.status === "pending" && (
                    <p className="text-slate-400" role="status">
                      Thinking, <Elapsed since={m.createdAt} /> so far. Your private AI can take a minute or more.{m.note && <span className="mt-1 block text-amber-300">{m.note}</span>}
                    </p>
                  )}
                  {m.status === "failed" && (
                    <div className="rounded-lg border border-red-800 bg-red-950/40 p-3 text-red-200" role="alert">
                      <p>{m.error ?? "This answer could not be completed."}</p>
                      <button className="mt-2 rounded border border-red-700 px-2 py-1 text-xs hover:bg-red-900/50" onClick={() => void retry(m.id)}>Retry</button>
                    </div>
                  )}
                  {m.status === "done" && (
                    <>
                      {m.warnings.map((w) => <p key={w} className="rounded-lg border border-amber-700 bg-amber-950/40 p-2 text-xs text-amber-200" role="note">Check this: {w}</p>)}
                      <div className="whitespace-pre-wrap leading-relaxed">{m.content}</div>
                      {m.sources.length > 0 && (
                        <div className="rounded-lg border border-slate-800 p-2">
                          <div className="text-[11px] uppercase text-slate-500">Sources from your data</div>
                          <ul className="mt-1 space-y-0.5">
                            {m.sources.map((s) => (
                              <li key={s.n} className="text-xs">
                                <span className="text-slate-500">[S{s.n}] {s.toolName}:</span>{" "}
                                {safeHref(s.href) ? <a className="underline" href={s.href}>{s.title}</a> : s.title}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {m.actions.length > 0 && (
                        <div className="flex flex-wrap gap-2" aria-label="Suggested pages">
                          {m.actions.filter((a) => safeHref(a.href)).map((a) => <a key={a.href} href={a.href} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs hover:bg-slate-800">{a.label}</a>)}
                        </div>
                      )}
                      <p className="text-[11px] text-slate-500">AI-generated from your connected data and general knowledge; may be wrong. Not legal, tax or financial advice.</p>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottom} />
        </div>

        {error && <p className="px-4 pb-2 text-sm text-red-300" role="alert">{error}</p>}
        <form className="flex gap-2 border-t border-slate-800 p-3" onSubmit={(e) => { e.preventDefault(); void ask(text); }}>
          <label htmlFor="founderai-input" className="sr-only">Your question</label>
          <textarea
            id="founderai-input" ref={input} rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(text); } }}
            className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Ask about your business…"
          />
          <button type="submit" disabled={busy || waitingForAnswer || !text.trim()} className="self-end rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-50">Ask</button>
        </form>
      </section>
    </div>
  );
}
