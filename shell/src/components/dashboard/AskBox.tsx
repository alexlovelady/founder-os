"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { askErrorMessage, SUGGESTED_PROMPTS } from "@/lib/dashboard/logic";

/** "Ask your business": starts a conversation through the Ask FounderOS tool API and opens it in the assistant. */
export default function AskBox({ canAsk = true }: { canAsk?: boolean }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [savedId, setSavedId] = useState<string>();

  async function ask(content: string) {
    const q = content.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(undefined);
    setSavedId(undefined);
    try {
      const r = await fetch("/api/tools/founderai/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: q }) });
      const d = (await r.json().catch(() => ({}))) as { error?: string; aiAvailable?: boolean; conversation?: { id: string } };
      if (!r.ok) {
        setError(askErrorMessage(r.status, d.error));
        return;
      }
      const id = d.conversation?.id;
      if (!id) {
        setError("The question was sent but the conversation could not be opened. Open Ask FounderOS to find it.");
        return;
      }
      if (d.aiAvailable === false) {
        setSavedId(id);
        setError("AI is not available for this business yet, so your question was saved but not answered.");
        return;
      }
      router.push(`/app/t/founderai/${id}`);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask(text);
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5" aria-labelledby="ask-title">
      <h2 id="ask-title" className="font-medium">Ask your business</h2>
      <p className="mt-1 text-xs text-slate-400">Answers use your own business data. It is not a lawyer, accountant or financial adviser.</p>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="ask-input" className="sr-only">Your question</label>
        <input
          id="ask-input" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} disabled={!canAsk || busy}
          placeholder="What should I work on this week?"
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400 disabled:opacity-60"
        />
        <button disabled={!canAsk || busy || !text.trim()} className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 disabled:opacity-60">
          {busy ? "Sending…" : "Ask"}
        </button>
      </form>
      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTED_PROMPTS.map((p) => (
          <button key={p} type="button" disabled={!canAsk || busy} onClick={() => void ask(p)} className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-60">
            {p}
          </button>
        ))}
      </div>
      <div aria-live="polite">
        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-950 px-3 py-2 text-sm text-red-200">
            {error}{" "}
            {savedId && <a className="underline" href={`/app/t/founderai/${savedId}`}>Open the saved conversation</a>}
          </p>
        )}
      </div>
    </section>
  );
}
