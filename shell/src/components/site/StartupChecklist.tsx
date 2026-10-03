"use client";
import Link from "next/link";
import { useState } from "react";
import { QUESTIONS, buildChecklist, type Answers } from "@/lib/site/checklist";
import { NOT_ADVICE_SHORT } from "@/lib/site/config";

export default function StartupChecklist() {
  const [answers, setAnswers] = useState<Answers>({});
  const steps = buildChecklist(answers);
  const answered = Object.keys(answers).length;

  return (
    <div className="space-y-8">
      <form onSubmit={(e) => e.preventDefault()} className="space-y-5">
        {QUESTIONS.map((q) => (
          <fieldset key={q.id} className="rounded-lg border border-slate-800 p-4">
            <legend className="px-1 text-sm font-medium text-slate-200">{q.label}</legend>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              {q.options.map((o) => (
                <label key={o.value} className="flex items-center gap-2 text-sm text-slate-300">
                  <input type="radio" name={q.id} value={o.value} checked={answers[q.id] === o.value} onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.value }))} />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </form>

      <section aria-live="polite">
        <h2 className="text-xl font-semibold text-slate-100">Your checklist</h2>
        <p className="mt-1 text-sm text-slate-400">
          {answered === 0 ? "Showing the full starter list. Answer the questions above to tailor it." : `Tailored from ${answered} of ${QUESTIONS.length} answers.`}
        </p>
        <ol className="mt-4 space-y-4">
          {steps.map((s, i) => (
            <li key={s.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
              <p className="font-semibold text-slate-100">{i + 1}. {s.title}</p>
              <p className="mt-1 text-sm text-slate-300">{s.why}</p>
              {s.links.length > 0 ? (
                <ul className="mt-2 space-y-1 text-sm">
                  {s.links.map((l) => (
                    <li key={l.href}>
                      <a href={l.href} target="_blank" rel="noopener noreferrer" className="text-sky-400 underline hover:text-sky-300">{l.label}</a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
        <p className="font-semibold text-slate-100">Save this and track it in FounderOS</p>
        <p className="mt-1 text-sm text-slate-300">This checklist was built in your browser and nothing was saved. FounderOS accounts are by invitation for now.</p>
        <Link href="/login" className="mt-3 inline-block rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white">Save this and track it in FounderOS: sign in</Link>
      </div>
      <p className="text-xs text-slate-500">
        {NOT_ADVICE_SHORT} Requirements differ by state, city and industry. This list is generic and US-focused, and it may be incomplete for your business. Links go to government websites we do not control.
      </p>
    </div>
  );
}
