"use client";
import Link from "next/link";
import { useState } from "react";
import { CATEGORIES, ITEMS, STATUS_LABEL, evaluate, type Answer, type Answers, type CategoryStatus } from "@/lib/site/health-check";
import { NOT_ADVICE_SHORT } from "@/lib/site/config";

const OPTIONS: { value: Answer; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "partly", label: "Partly" },
  { value: "no", label: "No" },
  { value: "na", label: "Not applicable" },
];

const TONE: Record<CategoryStatus, string> = {
  complete: "border-emerald-700 text-emerald-300",
  attention: "border-amber-600 text-amber-300",
  missing: "border-rose-700 text-rose-300",
  not_applicable: "border-slate-700 text-slate-400",
};

export default function HealthCheck() {
  const [answers, setAnswers] = useState<Answers>({});
  const [done, setDone] = useState(false);
  const allAnswered = ITEMS.every((i) => answers[i.id] !== undefined);
  const results = evaluate(answers);

  return (
    <div className="space-y-8">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (allAnswered) setDone(true);
        }}
        className="space-y-8"
      >
        {CATEGORIES.map((c) => (
          <section key={c} aria-labelledby={`cat-${c}`}>
            <h2 id={`cat-${c}`} className="text-xl font-semibold text-slate-100">{c}</h2>
            <div className="mt-3 space-y-3">
              {ITEMS.filter((i) => i.category === c).map((i) => (
                <fieldset key={i.id} className="rounded-lg border border-slate-800 p-4">
                  <legend className="px-1 text-sm text-slate-200">{i.question}</legend>
                  <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                    {OPTIONS.map((o) => (
                      <label key={o.value} className="flex items-center gap-2 text-sm text-slate-300">
                        <input
                          type="radio"
                          name={i.id}
                          value={o.value}
                          checked={answers[i.id] === o.value}
                          onChange={() => {
                            setDone(false);
                            setAnswers((a) => ({ ...a, [i.id]: o.value }));
                          }}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
            </div>
          </section>
        ))}
        <button type="submit" disabled={!allAnswered} className="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50">
          See my results
        </button>
        {!allAnswered ? <p className="text-sm text-slate-400">Answer every question to see results ({ITEMS.filter((i) => answers[i.id] !== undefined).length} of {ITEMS.length} answered).</p> : null}
      </form>

      {done ? (
        <section aria-live="polite" aria-labelledby="results" className="space-y-4">
          <h2 id="results" className="text-2xl font-semibold text-slate-50">Your results</h2>
          <p className="text-sm text-slate-400">There is no score. Each area shows where things stand based only on your answers.</p>
          <ul className="space-y-3">
            {results.map((r) => (
              <li key={r.category} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold text-slate-100">{r.category}</h3>
                  <span className={`rounded-full border px-3 py-0.5 text-sm ${TONE[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                </div>
                {r.todos.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">
                    {r.todos.map((t) => (
                      <li key={t.id}>{t.text}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
            <p className="font-semibold text-slate-100">Save this and track it in FounderOS</p>
            <p className="mt-1 text-sm text-slate-300">Your answers stayed in this browser tab and were not saved. FounderOS accounts are by invitation for now.</p>
            <Link href="/login" className="mt-3 inline-block rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white">Save this and track it in FounderOS: sign in</Link>
          </div>
        </section>
      ) : null}
      <p className="text-xs text-slate-500">{NOT_ADVICE_SHORT} This quick check is a prompt for thinking. It cannot know your situation and does not assess the quality or legality of anything.</p>
    </div>
  );
}
