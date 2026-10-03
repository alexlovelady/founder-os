"use client";
import { useCallback, useEffect, useState } from "react";
import { LinkedItems } from "@founderos/sdk/ui";
import type { Maturity } from "../analyze";

const AI_LABEL = "AI-generated analysis, check against sources. These are suggestions to review with a professional, not legal advice.";
const BASE = "/api/tools/product";

interface Repo { id: string; url: string; provider: string; owner: string; name: string; hasToken: boolean; lastScannedAt: string | null; status: string; lastError: string | null; latest?: { summary: string | null; stack: string[]; analysis: Record<string, { value: boolean }> } | null }
interface Detection { category: string; name: string; evidence: string[] }
interface Signal { value: boolean; evidence: string[] }
interface Scan {
  id: string; createdAt: string; aiState: string; aiSummary: string | null; aiError: string | null;
  result: {
    scannedAt: string; url: string;
    meta: { description: string | null; defaultBranch: string | null; license: string | null; stars: number | null; archived: boolean; private: boolean | null; pushedAt: string | null };
    languages: { name: string; pct: number }[];
    activity: { commitsLast90d: number | null; commitsCapped: boolean; lastCommitAt: string | null; contributors: number | null; contributorsCapped: boolean };
    tree: { totalEntries: number; truncated: boolean; topLevel: { path: string; type: string }[] };
    files: { path: string; bytes: number; truncated: boolean; kind: string }[];
    skipped: { path: string; reason: string }[];
    bytesRead: number;
    analysis: {
      frameworks: string[]; databases: string[]; services: Detection[]; repoLicense: string | null;
      declaredLicenses: { file: string; license: string }[]; copyleftHints: { name: string; note: string }[];
      signals: Record<string, Signal>; maturity: Maturity;
    };
  };
}

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

const SIGNAL_LABELS: Record<string, string> = {
  handlesUserAccounts: "Appears to handle user accounts",
  handlesPayments: "Appears to take payments",
  appearsToCollectPersonalData: "Appears to collect personal data",
  mayInvolveHealthData: "May involve health data",
  mayInvolveChildrensData: "May involve children's data",
  usesAiProviders: "Appears to use AI providers",
};

interface DetailData { repo: Repo; scans: { id: string; createdAt: string; hasAi: boolean }[]; latest: Scan | null }

function PlanLink({ msg }: { msg?: string }) {
  return msg && /plan/i.test(msg) ? <a className="ml-2 text-sm underline" href="/app/billing">See plans and usage</a> : null;
}

export default function ProductApp({ repoId, canWrite, aiAvailable, tokenStorage, initialRepos, initialDetail, scanIncluded = true }: { repoId?: string; canWrite: boolean; aiAvailable: boolean; tokenStorage: boolean; initialRepos?: Repo[]; initialDetail?: DetailData; scanIncluded?: boolean }) {
  return repoId && initialDetail ? <Detail repoId={repoId} initial={initialDetail} canWrite={canWrite} aiAvailable={aiAvailable} tokenStorage={tokenStorage} /> : <List initial={initialRepos ?? []} canWrite={canWrite} tokenStorage={tokenStorage} scanIncluded={scanIncluded} />;
}

function List({ initial, canWrite, tokenStorage, scanIncluded }: { initial: Repo[]; canWrite: boolean; tokenStorage: boolean; scanIncluded: boolean }) {
  const [repos, setRepos] = useState<Repo[]>(initial);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  const load = useCallback(async () => { try { setRepos((await api<{ repos: Repo[] }>("repos")).repos); } catch (e) { setMsg((e as Error).message); } }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(undefined);
    try {
      const d = await api<{ tokenNote: string | null }>("repos", "POST", { url, ...(token ? { token } : {}) });
      setUrl(""); setToken(""); setMsg(d.tokenNote ?? "Scanned.");
      await load();
    } catch (err) { setMsg((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 text-slate-100">
      <header>
        <h1 className="text-2xl font-semibold">Product Scan</h1>
        <p className="mt-1 text-sm text-slate-400">Link a GitHub or GitLab repository. FounderOS reads a small, capped set of files (README, dependency lists, config names) through the host&apos;s public API to understand what you built. It does not copy or store your source code.</p>
      </header>
      {!scanIncluded && <p role="status" className="text-sm text-amber-200">Repository scanning is not included in your plan. <a className="underline" href="/app/billing">See plans and usage</a></p>}
      {canWrite && scanIncluded && (
        <form onSubmit={add} className={`${card} space-y-3`}>
          <label className="block text-sm text-slate-300">Repository address
            <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo or https://gitlab.com/group/project" required />
          </label>
          <label className="block text-sm text-slate-300">Read-only access token (private repositories only, optional)
            <input className={input} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
            <span className="text-xs text-slate-500">{tokenStorage ? "If you add one, it is saved encrypted and never shown again. You can delete it later." : "This server cannot store tokens, so a token is used for this scan only and you will need to paste it again to re-scan."}</span>
          </label>
          <button className={btn} disabled={busy}>{busy ? "Scanning…" : "Link and scan"}</button>
        </form>
      )}
      {msg && <p role="status" className="text-sm text-amber-200">{msg}<PlanLink msg={msg} /></p>}
      {repos.length === 0 ? <p className="text-sm text-slate-400">No repositories linked yet.</p> : (
        <ul className="space-y-3">
          {repos.map((r) => (
            <li key={r.id} className={card}>
              <a className="text-lg font-medium underline" href={`/app/t/product/${r.id}`}>{r.owner}/{r.name}</a>
              <span className="ml-2 text-xs text-slate-500">{r.provider}{r.hasToken ? " · token saved" : ""}</span>
              <p className="mt-1 text-sm text-slate-300">{r.latest?.summary ?? (r.latest ? `Stack: ${r.latest.stack.join(", ") || "not detected"}` : r.lastError ?? "Not scanned yet")}</p>
              <p className="mt-1 text-xs text-slate-500">Last scanned {r.lastScannedAt ? new Date(r.lastScannedAt).toLocaleString() : "never"}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Detail({ repoId, initial, canWrite, aiAvailable, tokenStorage }: { repoId: string; initial: DetailData; canWrite: boolean; aiAvailable: boolean; tokenStorage: boolean }) {
  const [repo, setRepo] = useState<Repo>(initial.repo);
  const [scans, setScans] = useState(initial.scans);
  const [scan, setScan] = useState<Scan | null>(initial.latest);
  const [ai, setAi] = useState<{ state: string; text?: string | null; message?: string; error?: string | null }>(initial.latest ? { state: initial.latest.aiState, text: initial.latest.aiSummary, error: initial.latest.aiError } : { state: "none" });
  const [tick, setTick] = useState(0);
  const [diff, setDiff] = useState<{ changed: boolean; lines: string[] } | null>(null);
  const [msg, setMsg] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api<DetailData>(`repos/${repoId}`);
      setRepo(d.repo); setScans(d.scans); setScan(d.latest);
      setAi(d.latest ? { state: d.latest.aiState, text: d.latest.aiSummary, error: d.latest.aiError } : { state: "none" });
    } catch (e) { setMsg((e as Error).message); }
  }, [repoId]);

  // While the AI job runs, ask for its status every few seconds.
  const waiting = ai.state === "running" || ai.state === "waiting";
  const scanId = scan?.id;
  useEffect(() => {
    if (!waiting || !scanId) return;
    const t = setTimeout(async () => {
      try {
        setAi(await api<{ state: string; text?: string; message?: string; error?: string }>(`repos/${repoId}/scans/${scanId}/ai`));
      } catch (e) { setAi({ state: "failed", error: (e as Error).message }); }
      setTick((n) => n + 1);
    }, 3000);
    return () => clearTimeout(t);
  }, [waiting, scanId, repoId, tick]);

  async function run<T>(f: () => Promise<T>) { setBusy(true); setMsg(undefined); try { return await f(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } }

  const rescan = () => run(async () => { const d = await api<{ tokenNote: string | null }>(`repos/${repoId}/scan`, "POST", token ? { token } : {}); setToken(""); setDiff(null); if (d.tokenNote) setMsg(d.tokenNote); await load(); });
  const startAi = () => run(async () => { if (!scan) return; await api(`repos/${repoId}/scans/${scan.id}/ai`, "POST"); setAi({ state: "running" }); });
  const compare = () => run(async () => setDiff(await api(`repos/${repoId}/compare`)));
  const saveToken = () => run(async () => { await api(`repos/${repoId}/token`, "PUT", { token }); setToken(""); setMsg("Token saved encrypted."); await load(); });
  const removeToken = () => run(async () => { await api(`repos/${repoId}/token`, "DELETE"); setMsg("Token deleted."); await load(); });
  const remove = () => run(async () => { if (!confirm("Delete this repository and all its scan history?")) return; await api(`repos/${repoId}`, "DELETE"); // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/app/t/product"; });

  const r = scan?.result;
  const a = r?.analysis;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-4 text-slate-100">
      <a href="/app/t/product" className="text-sm text-slate-400 underline">All repositories</a>
      <header>
        <h1 className="text-2xl font-semibold">{repo.owner}/{repo.name}</h1>
        <p className="text-sm text-slate-400"><a className="underline" href={repo.url} rel="noreferrer noopener">{repo.url}</a> · last scanned {repo.lastScannedAt ? new Date(repo.lastScannedAt).toLocaleString() : "never"}{repo.lastError ? ` · last error: ${repo.lastError}` : ""}</p>
      </header>
      {msg && <p role="status" className="text-sm text-amber-200">{msg}<PlanLink msg={msg} /></p>}

      {canWrite && (
        <section className={`${card} space-y-3`} aria-label="Actions">
          <div className="flex flex-wrap gap-2">
            <button className={btn} disabled={busy} onClick={rescan}>{busy ? "Working…" : "Re-scan"}</button>
            <button className={btn2} disabled={busy || scans.length < 2} onClick={compare}>What changed since the last scan</button>
            <button className={btn2} disabled={busy} onClick={remove}>Delete</button>
          </div>
          <label className="block text-sm text-slate-300">Access token for private repositories (optional)
            <input className={input} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </label>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            {tokenStorage && <button className={btn2} disabled={busy || !token} onClick={saveToken}>Save token (encrypted)</button>}
            {repo.hasToken && <button className={btn2} disabled={busy} onClick={removeToken}>Delete saved token</button>}
            <span>{repo.hasToken ? "A token is saved (never shown)." : tokenStorage ? "No token saved." : "This server cannot store tokens; a token is used for the scan you run now only."}</span>
          </div>
        </section>
      )}

      {diff && (
        <section className={card} aria-label="Changes">
          <h2 className="font-medium">Changes since the previous scan</h2>
          {diff.changed ? <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">{diff.lines.map((l) => <li key={l}>{l}</li>)}</ul> : <p className="mt-2 text-sm text-slate-400">Nothing we track has changed.</p>}
        </section>
      )}

      {r && a && (
        <>
          <section className={card} aria-label="Overview">
            <h2 className="font-medium">Overview <span className="text-xs font-normal text-slate-500">from the code host, fetched {new Date(r.scannedAt).toLocaleDateString()}</span></h2>
            <p className="mt-2 text-sm text-slate-300">{r.meta.description ?? "No description."}</p>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
              <Row k="License" v={a.repoLicense ?? "None found"} />
              <Row k="Visibility" v={r.meta.private == null ? "Unknown" : r.meta.private ? "Private" : "Public"} />
              <Row k="Default branch" v={r.meta.defaultBranch ?? "Unknown"} />
              <Row k="Languages" v={r.languages.map((l) => `${l.name} ${l.pct}%`).join(", ") || "Unknown"} />
              <Row k="Commits, last 90 days" v={r.activity.commitsLast90d == null ? "Unknown" : `${r.activity.commitsLast90d}${r.activity.commitsCapped ? "+" : ""}`} />
              <Row k="Last commit" v={r.activity.lastCommitAt ? new Date(r.activity.lastCommitAt).toLocaleDateString() : "Unknown"} />
              <Row k="Contributors" v={r.activity.contributors == null ? "Unknown" : `${r.activity.contributors}${r.activity.contributorsCapped ? "+" : ""}`} />
              <Row k="Activity" v={String(a.maturity.activity)} />
            </dl>
          </section>

          <section className={card} aria-label="Technology">
            <h2 className="font-medium">Technology detected</h2>
            <p className="mt-1 text-xs text-slate-500">Detected from dependency names and environment variable names, not by running the code.</p>
            <dl className="mt-3 space-y-2 text-sm">
              <Row k="Frameworks" v={a.frameworks.join(", ") || "None detected"} />
              <Row k="Databases" v={a.databases.join(", ") || "None detected"} />
            </dl>
            <ul className="mt-3 space-y-1 text-sm">
              {a.services.map((s) => <li key={s.category + s.name}><span className="text-slate-400">{s.category}:</span> {s.name} <span className="text-xs text-slate-500">({s.evidence[0]})</span></li>)}
              {a.services.length === 0 && <li className="text-slate-400">No third-party services detected.</li>}
            </ul>
          </section>

          <section className={card} aria-label="Signals">
            <h2 className="font-medium">What the repository appears to involve</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {Object.entries(a.signals).map(([k, s]) => (
                <li key={k}><span className={s.value ? "text-amber-200" : "text-slate-400"}>{SIGNAL_LABELS[k] ?? k}: {s.value ? "yes, appears so" : "not seen"}</span>
                  {s.value && s.evidence.length > 0 && <span className="block text-xs text-slate-500">Evidence: {s.evidence.join("; ")}</span>}</li>
              ))}
            </ul>
            <h3 className="mt-4 text-sm font-medium">Maturity and documents</h3>
            <p className="mt-1 text-sm text-slate-300">{(["hasReadme", "hasTests", "hasCi", "hasDocs", "hasContainerConfig", "hasLicenseFile", "hasPrivacyPolicy", "hasTerms"] as const).map((k) => `${k.replace(/^has/, "").replace(/([A-Z])/g, " $1").trim()}: ${a.maturity[k] ? "yes" : "no"}`).join(" · ")}</p>
            {a.declaredLicenses.length > 0 && <p className="mt-2 text-xs text-slate-500">Licenses declared in manifests: {a.declaredLicenses.map((l) => `${l.license} (${l.file})`).join("; ")}. Licenses of dependencies are only visible when manifests declare them; run a license scanner for a full list.</p>}
            {a.copyleftHints.map((c) => <p key={c.name} className="mt-2 text-sm text-amber-200">{c.name}: {c.note}</p>)}
          </section>

          <section className={card} aria-label="AI analysis">
            <h2 className="font-medium">Business and legal read-out</h2>
            <p className="mt-1 text-xs text-slate-500">{AI_LABEL}</p>
            {ai.state === "done" || (ai.text && ai.state !== "running" && ai.state !== "waiting") ? <pre className="mt-3 whitespace-pre-wrap font-sans text-sm text-slate-200">{ai.text}</pre> : null}
            {(ai.state === "running" || ai.state === "waiting") && <p role="status" className="mt-3 text-sm text-slate-300">{ai.state === "waiting" ? ai.message : "Analysing the scan… this can take a few minutes on the private AI computer."}</p>}
            {ai.state === "failed" && <p role="alert" className="mt-3 text-sm text-red-300">{ai.error ?? "The analysis did not finish."}</p>}
            {canWrite && aiAvailable && ai.state !== "running" && ai.state !== "waiting" && <button className={`${btn2} mt-3`} disabled={busy} onClick={startAi}>{ai.text ? "Run the analysis again" : "Analyse with AI"}</button>}
            {!aiAvailable && <p className="mt-3 text-sm text-slate-400">AI is not available for this business right now. The scan results above do not need it.</p>}
          </section>

          <section className={card} aria-label="Files read">
            <h2 className="font-medium">What was read</h2>
            <p className="mt-1 text-xs text-slate-500">{r.tree.totalEntries} files in the tree{r.tree.truncated ? " (list truncated)" : ""}. {r.files.length} read, {Math.round(r.bytesRead / 1024)} KB in total. Only short excerpts are kept; environment files keep variable names only.</p>
            <ul className="mt-2 text-sm text-slate-300">{r.files.map((f) => <li key={f.path}>{f.path} <span className="text-xs text-slate-500">({f.kind}{f.truncated ? ", partly read" : ""})</span></li>)}</ul>
            {r.skipped.length > 0 && <p className="mt-2 text-xs text-slate-500">Skipped: {r.skipped.map((s) => `${s.path} (${s.reason})`).join(", ")}</p>}
          </section>
        </>
      )}
      {!scan && <p className="text-sm text-slate-400">No scan yet.</p>}
      <LinkedItems tool="product" id={repo.id} canWrite={canWrite} />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return <div><dt className="text-xs text-slate-400">{k}</dt><dd className="text-slate-200">{v}</dd></div>;
}
