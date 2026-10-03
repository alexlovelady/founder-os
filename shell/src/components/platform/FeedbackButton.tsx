"use client";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

const KINDS = [
  { id: "bug", label: "Something is broken" },
  { id: "feature", label: "Feature request" },
  { id: "confusing", label: "Something is confusing" },
  { id: "other", label: "Other" },
] as const;

/** Floating feedback button + modal. Mount once in a signed-in layout. Sends only the message, the page path and the browser string. */
export default function FeedbackButton() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("bug");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    area.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    setError("");
    try {
      const r = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, message, page: path }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error ?? "Could not send feedback");
      }
      setState("sent");
      setMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send feedback");
      setState("idle");
    }
  }

  function close() {
    setOpen(false);
    setState("idle");
    setError("");
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 rounded-full border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-100 shadow-lg hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-sky-400"
      >
        Feedback
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center" onClick={close}>
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-title"
            onSubmit={send}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md space-y-3 rounded-xl border border-slate-700 bg-slate-900 p-5 text-slate-100"
          >
            <h2 id="feedback-title" className="text-lg font-semibold">Send feedback</h2>
            {state === "sent" ? (
              <>
                <p className="text-sm text-slate-300">Thank you. We read every message.</p>
                <button type="button" onClick={close} className="rounded-lg bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500">Close</button>
              </>
            ) : (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-300">What kind?</span>
                  <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2">
                    {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-300">Your message</span>
                  <textarea ref={area} required maxLength={2000} rows={5} value={message} onChange={(e) => setMessage(e.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2" />
                </label>
                <p className="text-xs text-slate-500">We include the page you are on and your browser type. We never attach your documents. Please do not paste passwords or confidential text.</p>
                {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={close} className="rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-800">Cancel</button>
                  <button type="submit" disabled={state === "sending" || !message.trim()} className="rounded-lg bg-sky-600 px-4 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-50">
                    {state === "sending" ? "Sending..." : "Send"}
                  </button>
                </div>
              </>
            )}
          </form>
        </div>
      )}
    </>
  );
}
