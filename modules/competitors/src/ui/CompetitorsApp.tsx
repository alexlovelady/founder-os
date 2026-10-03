"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { LinkedItems } from "@founderos/sdk/ui";

const BASE = "/api/tools/competitors";
const AI_LABEL = "AI-generated analysis, check against sources.";

const input = "mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-slate-400";
const btn = "rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-white disabled:opacity-50";
const btn2 = "rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50";
const card = "rounded-xl border border-slate-800 bg-slate-900 p-5";

async function api<T = Record<string, unknown>>(path: string, method = "GET", body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? "Something went wrong");
  return d as T;
}

interface Comp { id: string; name: string; url: string; notes: string; source: string; status: string; lastError: string | null; lastFetchedAt: string | null; pagesRead?: number; pagesSkipped?: number; pagesChanged?: number; analysis?: { state: string; createdAt: string } | null }
interface PageInfo { id: string; url: string; userAdded: boolean; status: string; error: string | null; title: string; excerpt: string; fetchedAt: string | null; changed: boolean; previousFetchedAt: string | null }
interface Claim { field: string; text: string; source_url: string | null; fetched_at: string | null; quote: string | null; quote_verified: boolean | null }
interface Analysis { id: string; createdAt: string; state: string; error: string | null; message?: string; aiSummary: string | null; sources: { url: string; fetchedAt: string }[]; failed: string[]; parsed: boolean | null; claims: Claim[]; rejected: { field: string; text: string; reason: string }[]; comparison: string | null }
interface Report { id: string; createdAt: string; state: string; error: string | null; message?: string; text: string | null; competitors: { name: string; analysedAt: string }[] }

const FIELD_LABEL: Record<string, string> = { positioning: "Positioning", target_customer: "Target customer", offerings: "Offerings", pricing: "Pricing (quoted from the page)", strengths: "Strengths", weaknesses: "Weaknesses" };
const STATUS_LABEL: Record<string, string> = { new: "Not read yet", fetched: "Pages read", blocked: "Skipped (robots.txt)", error: "Could not be read" };

interface DetailData { competitor: Comp; pages: PageInfo[]; latest: Analysis | null }

export default function CompetitorsApp({ competitorId, canWrite, aiAvailable, searchEnabled, businessName, initialList, initialReports, initialDetail }: { competitorId?: string; canWrite: boolean; aiAvailable: boolean; searchEnabled: boolean; businessName: string; initialList?: Comp[]; initialReports?: Report[]; initialDetail?: DetailData }) {
  return competitorId && initialDetail
    ? <Detail id={competitorId} initial={initialDetail} canWrite={canWrite} aiAvailable={aiAvailable} />
    : <Home initialList={initialList ?? []} initialReport={initialReports?.[0] ?? null} canWrite={canWrite} aiAvailable={aiAvailable} searchEnabled={searchEnabled} businessName={businessName} />;
}

/** Re-runs `step` every 3 seconds while `active` is true. `tick` changes after each step so the next one is scheduled. */
function usePolling(active: boolean, step: () => Promise<void>) {
  const [tick, setTick] = useState(0);
  const latest = useRef(step);
  useEffect(() => { latest.current = step; });
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(async () => { try { await latest.current(); } finally { setTick((n) => n + 1); } }, 3000);
    return () => clearTimeout(t);
  }, [active, tick]);
}

function Home({ initialList, initialReport, canWrite, aiAvailable, searchEnabled, businessName }: { initialList: Comp[]; initialReport: Report | null; canWrite: boolean; aiAvailable: boolean; searchEnabled: boolean; businessName: string }) {
  const [list, setList] = useState<Comp[]>(initialList);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<"manual" | "search" | "ai_suggestion">("manual");
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<Report | null>(initialReport);
  const [discoveryId, setDiscoveryId] = useState<string | null>(null);
  const [disc, setDisc] = useState<{ source: string; label?: string; state?: string; message?: string; results?: { title: string; url: string; description: string }[]; suggestions?: { name: string; note: string }[] } | null>(null);
  const load = useCallback(async () => {
    try {
      setList((await api<{ competitors: Comp[] }>("competitors")).competitors);
      const reps = (await api<{ reports: Report[] }>("reports")).reports;
      setReport(reps[0] ?? null);
    } catch (e) { setMsg((e as Error).message); }
  }, []);

  usePolling(report?.state === "running" || report?.state === "waiting", async () => {
    if (!report) return;
    setReport((await api<{ report: Report }>(`reports/${report.id}`)).report);
  });
  usePolling(discoveryId !== null && (disc?.state === "running" || disc?.state === "waiting"), async () => {
    const r = await api<{ state: string; label?: string; message?: string; suggestions?: { name: string; note: string }[]; error?: string }>(`discover/${discoveryId}`);
    if (r.state === "running" || r.state === "waiting") setDisc({ source: "ai", state: r.state, message: r.message });
    else if (r.state === "failed") { setDisc(null); setMsg(r.error ?? "The suggestions did not finish"); }
    else setDisc({ source: "ai", state: "done", label: r.label, suggestions: r.suggestions });
  });

  async function add(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(undefined);
    try { await api("competitors", "POST", { name, url, source }); setName(""); setUrl(""); setSource("manual"); await load(); } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  }
  async function discover() {
    setBusy(true); setMsg(undefined); setDisc(null);
    try {
      const d = await api<{ source: string; label?: string; discoveryId?: string; results?: { title: string; url: string; description: string }[] }>("discover", "POST", {});
      if (d.source === "search") setDisc(d);
      else { setDiscoveryId(d.discoveryId ?? null); setDisc({ source: "ai", state: "running" }); }
    } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  }
  async function makeReport() {
    setBusy(true); setMsg(undefined);
    try { const d = await api<{ reportId: string }>("report", "POST"); setReport({ id: d.reportId, createdAt: new Date().toISOString(), state: "running", error: null, text: null, competitors: [] }); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 text-slate-100">
      <header>
        <h1 className="text-2xl font-semibold">Competitor Research</h1>
        <p className="mt-1 text-sm text-slate-400">Add competitors and FounderOS reads their public pages (home page plus pricing, product and about pages, at most 6). It identifies itself as FounderOS-Research, obeys robots.txt and never visits private addresses. Every extracted claim keeps its source page and date.</p>
      </header>
      {canWrite && (
        <form onSubmit={add} className={`${card} grid gap-3 sm:grid-cols-[1fr_1.4fr_auto]`}>
          <label className="block text-sm text-slate-300">Competitor name<input className={input} value={name} onChange={(e) => setName(e.target.value)} required /></label>
          <label className="block text-sm text-slate-300">Website<input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://competitor.com" required /></label>
          <div className="flex items-end"><button className={btn} disabled={busy}>Add</button></div>
        </form>
      )}
      {canWrite && (
        <section className={card} aria-label="Find competitors">
          <div className="flex flex-wrap items-center gap-3">
            <button className={btn2} disabled={busy || (!searchEnabled && !aiAvailable)} onClick={discover}>Suggest competitors for {businessName}</button>
            <span className="text-xs text-slate-500">{searchEnabled ? "Uses web search results." : aiAvailable ? "No search service is configured: the AI will suggest names from general knowledge. They are unverified." : "Neither web search nor AI is available right now. Add competitors yourself."}</span>
          </div>
          {disc?.state === "running" || disc?.state === "waiting" ? <p role="status" className="mt-3 text-sm text-slate-300">{disc.message ?? "Thinking…"}</p> : null}
          {disc && disc.label && <p className="mt-3 text-xs text-amber-200">{disc.label}</p>}
          <ul className="mt-2 space-y-2 text-sm">
            {disc?.results?.map((r) => (
              <li key={r.url} className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-medium">{r.title}</span> <span className="text-xs text-slate-500">{r.url}</span><span className="block text-xs text-slate-400">{r.description}</span></span>
                <button className={btn2} onClick={() => { setName(r.title.slice(0, 80)); setUrl(r.url); setSource("search"); }}>Use</button>
              </li>
            ))}
            {disc?.suggestions?.map((s) => (
              <li key={s.name} className="flex flex-wrap items-center justify-between gap-2">
                <span><span className="font-medium">{s.name}</span> <span className="rounded bg-amber-900/40 px-1 text-xs text-amber-200">unverified suggestion</span><span className="block text-xs text-slate-400">{s.note}</span></span>
                <button className={btn2} onClick={() => { setName(s.name); setUrl(""); setSource("ai_suggestion"); }}>Use name, I will add the website</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {msg && <p role="status" className="text-sm text-amber-200">{msg}</p>}
      {list.length === 0 ? <p className="text-sm text-slate-400">No competitors added yet.</p> : (
        <ul className="space-y-3">
          {list.map((c) => (
            <li key={c.id} className={card}>
              <a className="text-lg font-medium underline" href={`/app/t/competitors/${c.id}`}>{c.name}</a>
              <span className="ml-2 text-xs text-slate-500">{c.url}{c.source === "ai_suggestion" ? " · from an unverified AI suggestion" : c.source === "search" ? " · found by web search" : ""}</span>
              <p className="mt-1 text-sm text-slate-300">{STATUS_LABEL[c.status] ?? c.status}{c.lastError && c.status !== "fetched" ? `: ${c.lastError}` : ""}{c.pagesRead ? ` · ${c.pagesRead} pages read` : ""}{c.pagesChanged ? ` · ${c.pagesChanged} changed since the previous check` : ""}</p>
              <p className="text-xs text-slate-500">Last checked {c.lastFetchedAt ? new Date(c.lastFetchedAt).toLocaleString() : "never"}{c.analysis ? ` · analysis ${c.analysis.state === "done" ? "from " + new Date(c.analysis.createdAt).toLocaleDateString() : c.analysis.state}` : ""}</p>
            </li>
          ))}
        </ul>
      )}
      <section className={card} aria-label="Market report">
        <h2 className="font-medium">Cross-competitor report</h2>
        <p className="mt-1 text-xs text-slate-500">{AI_LABEL} Built only from the sourced claims of competitors you have analysed. The &quot;stand out&quot; ideas are the AI&apos;s opinion.</p>
        {report?.state === "done" && <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-slate-200">{report.text}</pre>}
        {(report?.state === "running" || report?.state === "waiting") && <p role="status" className="mt-3 text-sm text-slate-300">{report.message ?? "Writing the report… this can take a few minutes."}</p>}
        {report?.state === "failed" && <p role="alert" className="mt-3 text-sm text-red-300">{report.error ?? "The report did not finish."}</p>}
        {report?.state === "done" && <p className="mt-2 text-xs text-slate-500">Based on analyses of: {report.competitors.map((c) => `${c.name} (${c.analysedAt.slice(0, 10)})`).join(", ")}</p>}
        {canWrite && aiAvailable && report?.state !== "running" && report?.state !== "waiting" && <button className={`${btn2} mt-3`} disabled={busy} onClick={makeReport}>{report ? "Write a new report" : "Write a report"}</button>}
        {!aiAvailable && <p className="mt-3 text-sm text-slate-400">AI is not available right now. The fetched pages and their sources are still available on each competitor.</p>}
      </section>
    </div>
  );
}

function Detail({ id, initial, canWrite, aiAvailable }: { id: string; initial: DetailData; canWrite: boolean; aiAvailable: boolean }) {
  const [comp, setComp] = useState<Comp>(initial.competitor);
  const [pages, setPages] = useState<PageInfo[]>(initial.pages);
  const [analysis, setAnalysis] = useState<Analysis | null>(initial.latest);
  const [extra, setExtra] = useState("");
  const [notes, setNotes] = useState(initial.competitor.notes);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const d = await api<DetailData>(`competitors/${id}`);
      setComp(d.competitor); setPages(d.pages); setAnalysis(d.latest); setNotes(d.competitor.notes);
    } catch (e) { setMsg((e as Error).message); }
  }, [id]);

  usePolling(analysis?.state === "running" || analysis?.state === "waiting", async () => {
    if (!analysis) return;
    setAnalysis((await api<{ analysis: Analysis }>(`competitors/${id}/analyses/${analysis.id}`)).analysis);
  });

  async function run(f: () => Promise<void>) { setBusy(true); setMsg(undefined); try { await f(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } }
  const fetchPages = () => run(async () => { const d = await api<{ skipped: { url: string; reason: string }[]; changed: string[] }>(`competitors/${id}/fetch`, "POST"); setMsg([d.skipped.length ? `Skipped or failed: ${d.skipped.map((s) => `${s.url} (${s.reason})`).join("; ")}` : "", d.changed.length ? `Changed since the previous check: ${d.changed.join(", ")}` : ""].filter(Boolean).join(" ")); await load(); });
  const analyse = () => run(async () => { const d = await api<{ analysisId: string }>(`competitors/${id}/analyze`, "POST"); setAnalysis({ id: d.analysisId, createdAt: new Date().toISOString(), state: "running", error: null, aiSummary: null, sources: [], failed: [], parsed: null, claims: [], rejected: [], comparison: null }); });
  const addPage = (e: React.FormEvent) => { e.preventDefault(); void run(async () => { await api(`competitors/${id}/pages`, "POST", { url: extra }); setExtra(""); await load(); }); };
  const removePage = (pid: string) => run(async () => { await api(`competitors/${id}/pages/${pid}`, "DELETE"); await load(); });
  const saveNotes = () => run(async () => { await api(`competitors/${id}`, "PATCH", { notes }); setMsg("Notes saved."); });
  const remove = () => run(async () => { if (!confirm("Delete this competitor and everything read from their site?")) return; await api(`competitors/${id}`, "DELETE");
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/app/t/competitors"; });

  const grouped = analysis ? Object.keys(FIELD_LABEL).map((f) => ({ f, items: analysis.claims.filter((c) => c.field === f) })).filter((g) => g.items.length > 0) : [];

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 text-slate-100">
      <a href="/app/t/competitors" className="text-sm text-slate-400 underline">All competitors</a>
      <header>
        <h1 className="text-2xl font-semibold">{comp.name}</h1>
        <p className="text-sm text-slate-400"><a className="underline" href={comp.url} rel="noreferrer noopener">{comp.url}</a> · {STATUS_LABEL[comp.status] ?? comp.status} · last checked {comp.lastFetchedAt ? new Date(comp.lastFetchedAt).toLocaleString() : "never"}</p>
        {comp.source === "ai_suggestion" && <p className="mt-1 text-xs text-amber-200">This name began as an unverified AI suggestion. Check the website is the right company.</p>}
      </header>
      {msg && <p role="status" className="text-sm text-amber-200">{msg}</p>}

      {canWrite && (
        <section className={`${card} space-y-3`} aria-label="Actions">
          <div className="flex flex-wrap gap-2">
            <button className={btn} disabled={busy} onClick={fetchPages}>{busy ? "Working…" : comp.lastFetchedAt ? "Fetch again and check for changes" : "Fetch their public pages"}</button>
            {aiAvailable && <button className={btn2} disabled={busy || !pages.some((p) => p.status === "ok") || analysis?.state === "running"} onClick={analyse}>Analyse with AI</button>}
            <button className={btn2} disabled={busy} onClick={remove}>Delete</button>
          </div>
          <form onSubmit={addPage} className="flex flex-wrap items-end gap-2">
            <label className="block flex-1 text-sm text-slate-300">Add a page on their site (max 5)<input className={input} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={`${comp.url.replace(/\/$/, "")}/pricing`} /></label>
            <button className={btn2} disabled={busy || !extra}>Add page</button>
          </form>
          <label className="block text-sm text-slate-300">Your notes<textarea className={input} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          <button className={btn2} disabled={busy || notes === comp.notes} onClick={saveNotes}>Save notes</button>
        </section>
      )}

      <section className={card} aria-label="Pages read">
        <h2 className="font-medium">Pages</h2>
        <p className="mt-1 text-xs text-slate-500">Only text that a public page shows is read. Pages whose robots.txt asks tools not to read them are skipped.</p>
        {pages.length === 0 && <p className="mt-2 text-sm text-slate-400">Nothing fetched yet.</p>}
        <ul className="mt-3 space-y-3 text-sm">
          {pages.map((p) => (
            <li key={p.id}>
              <a className="underline" href={p.url} rel="noreferrer noopener">{p.title || p.url}</a>
              {p.userAdded && <span className="ml-2 text-xs text-slate-500">added by you</span>}
              <span className="ml-2 text-xs text-slate-500">{p.status === "ok" ? `read ${p.fetchedAt ? new Date(p.fetchedAt).toLocaleDateString() : ""}` : p.status === "blocked_robots" ? "skipped: robots.txt" : p.status === "pending" ? "not fetched yet" : "could not be fetched"}</span>
              {p.changed && <span className="ml-2 rounded bg-sky-900/50 px-1 text-xs text-sky-200">changed since {p.previousFetchedAt ? new Date(p.previousFetchedAt).toLocaleDateString() : "the previous check"}</span>}
              {p.error && p.status !== "ok" && <span className="block text-xs text-slate-400">{p.error}</span>}
              {canWrite && <button className="ml-2 text-xs text-slate-400 underline" onClick={() => removePage(p.id)}>Remove</button>}
            </li>
          ))}
        </ul>
      </section>

      <section className={card} aria-label="Analysis">
        <h2 className="font-medium">Analysis</h2>
        <p className="mt-1 text-xs text-slate-500">{AI_LABEL} Each claim names the page it came from and when it was fetched. Prices appear only when quoted on a page.</p>
        {(analysis?.state === "running" || analysis?.state === "waiting") && <p role="status" className="mt-3 text-sm text-slate-300">{analysis.message ?? "Analysing their pages… this can take a few minutes."}</p>}
        {analysis?.state === "failed" && <p role="alert" className="mt-3 text-sm text-red-300">{analysis.error ?? "The analysis did not finish."}</p>}
        {analysis?.state === "done" && (
          <div className="mt-3 space-y-4 text-sm">
            <p className="text-xs text-slate-500">Analysed {new Date(analysis.createdAt).toLocaleString()} from {analysis.sources.length} page{analysis.sources.length === 1 ? "" : "s"}.{analysis.failed.length > 0 ? ` Not read: ${analysis.failed.join("; ")}.` : ""}</p>
            {analysis.parsed === false && <div><p className="text-amber-200">The AI answer could not be matched to the fetched pages, so none of it is shown as sourced:</p><pre className="mt-2 whitespace-pre-wrap font-sans text-slate-300">{analysis.aiSummary}</pre></div>}
            {grouped.map((g) => (
              <div key={g.f}>
                <h3 className="font-medium">{FIELD_LABEL[g.f]}</h3>
                <ul className="mt-1 space-y-2">
                  {g.items.map((c, i) => (
                    <li key={i} className="text-slate-200">{c.text}
                      <span className="block text-xs text-slate-500">
                        {c.source_url ? <>Source: <a className="underline" href={c.source_url} rel="noreferrer noopener">{c.source_url}</a>, fetched {c.fetched_at?.slice(0, 10)}</> : "No source page: treat as AI opinion"}
                        {c.quote && <> · {c.quote_verified ? "quote found on the page" : "quote NOT found on the page"}: &ldquo;{c.quote}&rdquo;</>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {analysis.parsed && grouped.length === 0 && <p className="text-slate-400">The pages did not give enough to extract claims.</p>}
            {analysis.rejected.length > 0 && <p className="text-xs text-slate-500">Discarded as unverifiable: {analysis.rejected.map((r) => `"${r.text}" (${r.reason})`).join("; ")}</p>}
            {analysis.comparison && <div><h3 className="font-medium">How they compare with you (AI opinion)</h3><p className="mt-1 text-slate-300">{analysis.comparison}</p></div>}
          </div>
        )}
        {!analysis && <p className="mt-3 text-sm text-slate-400">{aiAvailable ? "Fetch their pages, then run the analysis." : "AI is not available right now. You can still read the fetched pages above."}</p>}
      </section>
      <LinkedItems tool="competitors" id={comp.id} canWrite={canWrite} />
    </div>
  );
}
