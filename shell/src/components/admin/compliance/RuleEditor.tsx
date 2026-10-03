"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, RECURRENCES } from "@founderos/compliance/src/engine";

export interface EditorContent {
  title: string; description: string; category: string; conditions: unknown[]; alwaysCautious: boolean; recommendation: string; cautious: string | null;
  priority: "high" | "normal"; sourceTitle: string; sourceUrl: string; jurisdiction: string; lastVerified: string | null; recurrence: string | null;
  deadline: { month: number; day: number } | null;
}
export interface EditorRule {
  slug: string; version: number; status: "draft" | "published" | "disabled"; content: EditorContent;
  lastCheck: { at: string; status: number | null; finalUrl: string | null; note: string } | null;
}
export interface EditorVersion { id: number; version: number; changedBy: string; changedAt: string; note: string; title: string; status: string }
interface PreviewRow { key: string; label: string; applies: boolean; certainty: "certain" | "uncertain" | null; wording: string | null }

const EMPTY: EditorContent = {
  title: "", description: "", category: "other", conditions: [{ type: "country", in: ["US"] }], alwaysCautious: true, recommendation: "Review whether ... applies to your business.",
  cautious: null, priority: "normal", sourceTitle: "", sourceUrl: "", jurisdiction: "US", lastVerified: null, recurrence: null, deadline: null,
};

const SNIPPETS: [string, unknown][] = [
  ["Country is US", { type: "country", in: ["US"] }],
  ["State is NC", { type: "state", is: "NC" }],
  ["Entity type", { type: "entity", in: ["llc", "corporation", "s_corp", "partnership"] }],
  ["Not idea stage", { type: "stage", notIn: ["idea"] }],
  ["Has employees", { type: "anyOf", of: [{ type: "flag", key: "hasEmployees" }, { type: "employees", min: 1 }] }],
  ["Uses contractors", { type: "flag", key: "usesContractors" }],
  ["Takes online payments", { type: "flag", key: "takesOnlinePayments" }],
  ["Industry contains", { type: "industry", any: ["restaurant"] }],
];

const input = "mt-1 block w-full rounded border border-slate-700 bg-slate-950 p-2 text-sm text-slate-100";
const label = "block text-xs text-slate-400";
const btn = "rounded px-3 py-1.5 text-sm text-white disabled:opacity-50";

export default function RuleEditor({ rule, versions }: { rule: EditorRule | null; versions: EditorVersion[] }) {
  const router = useRouter();
  const start = rule?.content ?? EMPTY;
  const [slug, setSlug] = useState(rule?.slug ?? "");
  const [f, setF] = useState({
    title: start.title, description: start.description, category: start.category, alwaysCautious: start.alwaysCautious, recommendation: start.recommendation,
    cautious: start.cautious ?? "", priority: start.priority, sourceTitle: start.sourceTitle, sourceUrl: start.sourceUrl, jurisdiction: start.jurisdiction,
    lastVerified: start.lastVerified ?? "", recurrence: start.recurrence ?? "", deadlineMonth: start.deadline ? String(start.deadline.month) : "", deadlineDay: start.deadline ? String(start.deadline.day) : "",
  });
  const [condText, setCondText] = useState(JSON.stringify(start.conditions, null, 2));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ rows?: PreviewRow[]; error?: string }>({});

  const built = useMemo(() => {
    let conditions: unknown;
    try {
      conditions = JSON.parse(condText);
    } catch {
      return { error: "Conditions must be valid JSON (a list).", content: null };
    }
    return {
      error: null,
      content: {
        title: f.title, description: f.description, category: f.category, conditions, alwaysCautious: f.alwaysCautious, recommendation: f.recommendation,
        cautious: f.cautious.trim() ? f.cautious : null, priority: f.priority, sourceTitle: f.sourceTitle, sourceUrl: f.sourceUrl, jurisdiction: f.jurisdiction,
        lastVerified: f.lastVerified || null, recurrence: f.recurrence || null,
        deadline: f.deadlineMonth && f.deadlineDay ? { month: Number(f.deadlineMonth), day: Number(f.deadlineDay) } : null,
      },
    };
  }, [f, condText]);

  // Live preview against the sample businesses (debounced).
  const seq = useRef(0);
  useEffect(() => {
    if (!built.content) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const r = await fetch("/api/admin/compliance/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(built.content) });
        const j = await r.json();
        if (mine === seq.current) setPreview(r.ok ? { rows: j.rows } : { error: j.error ?? "Could not preview" });
      } catch {
        if (mine === seq.current) setPreview({ error: "Could not reach the server" });
      }
    }, 400);
    return () => clearTimeout(t);
  }, [built]);

  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function send(url: string, method: string, payload?: unknown, then?: (j: Record<string, unknown>) => void) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(url, { method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const problems = Array.isArray(j.problems) && j.problems.length > 1 ? ` (${j.problems.join("; ")})` : "";
        setMsg({ ok: false, text: `${j.error ?? "Failed"}${problems}` });
      } else then?.(j);
    } finally {
      setBusy(false);
    }
  }

  const save = () => {
    if (!built.content) return setMsg({ ok: false, text: built.error ?? "Invalid conditions" });
    if (!rule) {
      void send("/api/admin/compliance", "POST", { slug, ...built.content }, (j) => router.push(`/admin/compliance/${(j.rule as { slug: string }).slug}`));
    } else {
      void send(`/api/admin/compliance/${rule.slug}`, "PATCH", built.content, (j) => { setMsg({ ok: true, text: j.changed ? "Saved." : "No changes." }); router.refresh(); });
    }
  };
  const act = (action: string, payload?: unknown, okText?: string) =>
    void send(`/api/admin/compliance/${rule!.slug}/${action}`, "POST", payload ?? {}, (j) => {
      const check = j.result as { note?: string } | undefined;
      setMsg({ ok: true, text: check?.note ?? okText ?? "Done." });
      router.refresh();
    });

  const addSnippet = (i: number) => {
    try {
      const cur = JSON.parse(condText);
      setCondText(JSON.stringify([...(Array.isArray(cur) ? cur : []), SNIPPETS[i][1]], null, 2));
    } catch {
      setCondText(JSON.stringify([SNIPPETS[i][1]], null, 2));
    }
  };

  const status = rule?.status ?? "draft";
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {!rule && (
          <label className={label}>Rule id (cannot be changed; becomes admin:&lt;id&gt;)
            <input className={`${input} font-mono`} value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="nc-sales-tax-registration" required />
          </label>
        )}
        <label className={label}>Title<input className={input} value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={200} required /></label>
        <label className={label}>Description (what the source says, in plain words)<textarea className={input} rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} maxLength={2000} /></label>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className={label}>Category<select className={input} value={f.category} onChange={(e) => set("category", e.target.value)}>{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className={label}>Priority<select className={input} value={f.priority} onChange={(e) => set("priority", e.target.value as "high" | "normal")}><option>normal</option><option>high</option></select></label>
          <label className={label}>Jurisdiction<input className={input} value={f.jurisdiction} onChange={(e) => set("jurisdiction", e.target.value)} maxLength={100} /></label>
        </div>

        <fieldset className="space-y-2 rounded border border-slate-800 p-3">
          <legend className="px-1 text-xs text-slate-400">Conditions (all must hold; the same language the built-in rules use)</legend>
          <textarea aria-label="Conditions as JSON" className={`${input} font-mono`} rows={8} value={condText} onChange={(e) => setCondText(e.target.value)} spellCheck={false} />
          <label className={label}>Add a condition
            <select className={input} value="" onChange={(e) => e.target.value !== "" && addSnippet(Number(e.target.value))}>
              <option value="">Choose a template to append...</option>
              {SNIPPETS.map(([n], i) => <option key={n} value={i}>{n}</option>)}
            </select>
          </label>
          <p className="text-xs text-slate-500">A condition that cannot be decided from the business profile makes the wording cautious. Types: country, state (two-letter code), entity, stage, flag, employees, industry, industryKnown, anyOf.</p>
        </fieldset>

        <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={f.alwaysCautious} onChange={(e) => set("alwaysCautious", e.target.checked)} />Always cautious (applicability depends on facts we cannot know; wording must say &quot;Review whether ...&quot;)</label>
        <label className={label}>Recommendation wording (shown when the rule certainly applies)<textarea className={input} rows={2} value={f.recommendation} onChange={(e) => set("recommendation", e.target.value)} maxLength={1000} /></label>
        <label className={label}>Cautious wording (shown when applicability is uncertain; optional)<textarea className={input} rows={2} value={f.cautious} onChange={(e) => set("cautious", e.target.value)} maxLength={1000} /></label>

        <fieldset className="space-y-3 rounded border border-slate-800 p-3">
          <legend className="px-1 text-xs text-slate-400">Source (required to publish)</legend>
          <label className={label}>Source title<input className={input} value={f.sourceTitle} onChange={(e) => set("sourceTitle", e.target.value)} maxLength={200} /></label>
          <label className={label}>Source URL (https only)<input className={input} type="url" value={f.sourceUrl} onChange={(e) => set("sourceUrl", e.target.value)} placeholder="https://" /></label>
          <label className={label}>Last verified (the day a person loaded the source and confirmed it)<input className={input} type="date" value={f.lastVerified} onChange={(e) => set("lastVerified", e.target.value)} /></label>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <label className={label}>Repeats<select className={input} value={f.recurrence} onChange={(e) => set("recurrence", e.target.value)}><option value="">does not repeat</option>{RECURRENCES.map((r) => <option key={r}>{r}</option>)}</select></label>
          <label className={label}>Fixed deadline month (only if the source states one)<input className={input} type="number" min={1} max={12} value={f.deadlineMonth} onChange={(e) => set("deadlineMonth", e.target.value)} /></label>
          <label className={label}>Fixed deadline day<input className={input} type="number" min={1} max={31} value={f.deadlineDay} onChange={(e) => set("deadlineDay", e.target.value)} /></label>
        </div>

        {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</p>}

        <div className="flex flex-wrap gap-2">
          <button disabled={busy} className={`${btn} bg-sky-600 hover:bg-sky-500`}>{rule ? "Save changes" : "Create draft"}</button>
          {rule && status !== "published" && <button type="button" disabled={busy} onClick={() => act("publish", {}, "Published. Businesses get it at their next checklist sync.")} className={`${btn} bg-emerald-700 hover:bg-emerald-600`}>{status === "disabled" ? "Re-publish" : "Publish"}</button>}
          {rule && status === "published" && <button type="button" disabled={busy} onClick={() => act("disable", {}, "Disabled. Untouched items from this rule leave checklists at their next sync.")} className={`${btn} bg-amber-700 hover:bg-amber-600`}>Disable</button>}
          {rule && <button type="button" disabled={busy} onClick={() => act("verify", {}, "Marked verified today.")} className={`${btn} bg-slate-700 hover:bg-slate-600`}>Mark verified today</button>}
          {rule && <button type="button" disabled={busy || !rule.content.sourceUrl} onClick={() => act("check")} className={`${btn} bg-slate-700 hover:bg-slate-600`}>Check source now</button>}
        </div>
        {rule?.lastCheck && (
          <p className="text-xs text-slate-400">Last source check {rule.lastCheck.at.slice(0, 16).replace("T", " ")} UTC: {rule.lastCheck.status ?? "not fetched"}{rule.lastCheck.finalUrl ? ` at ${rule.lastCheck.finalUrl}` : ""}. {rule.lastCheck.note}</p>
        )}
      </form>

      <aside className="space-y-6">
        <section aria-live="polite">
          <h2 className="mb-2 font-medium">Preview: who would get this rule</h2>
          <p className="mb-2 text-xs text-slate-500">Evaluated with the real rules engine against invented sample businesses (unsaved edits included).</p>
          {(built.error ?? preview.error) && <p className="text-sm text-amber-400">{built.error ?? preview.error}</p>}
          <ul className="space-y-2 text-sm">
            {!built.error && preview.rows?.map((r) => (
              <li key={r.key} className="rounded border border-slate-800 p-2">
                <div className="flex items-center justify-between gap-2"><span>{r.label}</span>
                  <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${r.applies ? (r.certainty === "certain" ? "bg-emerald-900 text-emerald-200" : "bg-amber-900 text-amber-200") : "bg-slate-800 text-slate-400"}`}>{r.applies ? r.certainty : "no"}</span></div>
                {r.wording && <p className="mt-1 text-xs text-slate-400">{r.wording}</p>}
              </li>
            ))}
          </ul>
        </section>

        {rule && (
          <section>
            <h2 className="mb-2 font-medium">Versions <span className="text-xs text-slate-500">(current v{rule.version}, {status})</span></h2>
            <ul className="space-y-2 text-sm">
              {versions.map((v) => (
                <li key={v.id} className="rounded border border-slate-800 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <span>v{v.version} <span className="text-xs text-slate-500">{v.changedAt.slice(0, 16).replace("T", " ")}</span></span>
                    {v.version !== rule.version && <button type="button" disabled={busy} onClick={() => act("restore", { version: v.version }, `Restored v${v.version} as a new version.`)} className="rounded bg-slate-700 px-2 py-0.5 text-xs text-white hover:bg-slate-600 disabled:opacity-50">Restore</button>}
                  </div>
                  <div className="text-xs text-slate-400">{v.note || "change"} by <span className="font-mono">{v.changedBy.slice(0, 12)}</span></div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}
