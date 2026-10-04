"use client";
import { useEffect, useState } from "react";
import type { Flag } from "../guard";
import { KIND_LABEL, KINDS, TONES, type Brand, type ItemKind } from "../prompts";
import { TEMPLATE_TONES } from "../templates";
import { api, btn, btn2, input, JobStatus, useAiJob, Warnings, type Item } from "./shared";

type Tab = "brand" | "create" | "library" | "calendar";
const TONE_LABEL: Record<(typeof TONES)[number], [string, string]> = { formal: ["Casual", "Formal"], playful: ["Serious", "Playful"], bold: ["Reserved", "Bold"], warm: ["Matter-of-fact", "Warm"] };

export default function MarketingApp({ brand, brandSaved, items, canWrite, aiAvailable }: { brand: Brand; brandSaved: boolean; items: Item[]; canWrite: boolean; aiAvailable: boolean }) {
  const [tab, setTab] = useState<Tab>(brandSaved ? "create" : "brand");
  const tabs: [Tab, string][] = [["brand", "Brand voice"], ["create", "Create copy"], ["library", `Library (${items.length})`], ["calendar", "Calendar"]];
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <header>
        <p className="text-sm text-slate-400">Drafts that sound like your business. This tool writes copy only: it does not post anywhere and does not track results.</p>
      </header>
      <div role="tablist" className="flex flex-wrap gap-2">
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 text-sm ${tab === k ? "bg-slate-100 text-slate-900" : "border border-slate-700 text-slate-300"}`}>{l}</button>)}
      </div>
      {tab === "brand" && <BrandForm initial={brand} canWrite={canWrite} aiAvailable={aiAvailable} />}
      {tab === "create" && <Create canWrite={canWrite} aiAvailable={aiAvailable} brandSaved={brandSaved} />}
      {tab === "library" && <Library items={items} />}
      {tab === "calendar" && <Calendar />}
    </div>
  );
}

function BrandForm({ initial, canWrite, aiAvailable }: { initial: Brand; canWrite: boolean; aiAvailable: boolean }) {
  const [b, setB] = useState(initial);
  const [notes, setNotes] = useState("");
  const [msg, setMsg] = useState<string>();
  const [err, setErr] = useState<string>();
  const [aiShown, setAiShown] = useState(false);
  const { job, start, busy } = useAiJob((d) => { if (d.suggestion) { setB((cur) => ({ ...cur, ...d.suggestion })); setAiShown(true); } });
  async function save() {
    setErr(undefined); setMsg(undefined);
    const r = await api("brand", "PUT", b);
    if (r.ok) { setMsg("Brand voice saved."); setAiShown(false); } else setErr(r.data.error ?? "Could not save");
  }
  const set = (k: keyof Omit<Brand, "tone">, v: string) => setB({ ...b, [k]: v });
  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Brand voice">
      <p className="text-sm text-slate-400">Describe how your business sounds. Every draft uses this. Nothing here is posted anywhere.</p>
      {canWrite && (
        <div className="space-y-2 rounded-lg border border-slate-800 p-3">
          <label className="block text-sm">Optional: tell the AI a bit about your style
            <input className={input} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. friendly neighbourhood shop, no jargon" />
          </label>
          <button className={btn2} disabled={!aiAvailable || busy} onClick={() => start("brand/suggest", { notes })}>Suggest a voice from my business profile (AI)</button>
          {!aiAvailable && <p className="text-xs text-slate-500">AI is not available right now. Fill the fields in by hand.</p>}
          <JobStatus job={job} />
        </div>
      )}
      {aiShown && <p className="text-xs font-medium text-amber-300">AI draft, review before use. Edit the fields, replace any [●PLACEHOLDER], then save.</p>}
      {job.state === "done" && <Warnings flags={job.flags} warning={job.warning} />}
      <label className="block text-sm">Voice: how do you sound?<textarea className={`${input} h-20`} value={b.voice} onChange={(e) => set("voice", e.target.value)} /></label>
      <label className="block text-sm">Audience / persona: who are you talking to?<textarea className={`${input} h-20`} value={b.audience} onChange={(e) => set("audience", e.target.value)} /></label>
      <label className="block text-sm">Offers: what do you sell? (include real prices only if you want them used)<textarea className={`${input} h-20`} value={b.offers} onChange={(e) => set("offers", e.target.value)} /></label>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">Words to use<input className={input} value={b.doWords} onChange={(e) => set("doWords", e.target.value)} /></label>
        <label className="block text-sm">Words to avoid<input className={input} value={b.dontWords} onChange={(e) => set("dontWords", e.target.value)} /></label>
      </div>
      <fieldset className="grid gap-3 md:grid-cols-2">
        <legend className="text-sm">Tone</legend>
        {TONES.map((t) => (
          <label key={t} className="block text-xs text-slate-400">
            <span className="flex justify-between"><span>{TONE_LABEL[t][0]}</span><span>{TONE_LABEL[t][1]}</span></span>
            <input type="range" min={0} max={100} className="w-full" aria-label={`${TONE_LABEL[t][0]} to ${TONE_LABEL[t][1]}`} value={b.tone[t]} onChange={(e) => setB({ ...b, tone: { ...b.tone, [t]: Number(e.target.value) } })} />
          </label>
        ))}
      </fieldset>
      {canWrite ? <button className={btn} onClick={save}>Save brand voice</button> : <p className="text-xs text-slate-500">Your role cannot change the brand voice.</p>}
      {msg && <p className="text-sm text-emerald-300" role="status">{msg}</p>}
      {err && <p className="text-sm text-red-300" role="alert">{err}</p>}
    </section>
  );
}

function Create({ canWrite, aiAvailable, brandSaved }: { canWrite: boolean; aiAvailable: boolean; brandSaved: boolean }) {
  const [kind, setKind] = useState<ItemKind>("social_post");
  const [topic, setTopic] = useState("");
  const [channel, setChannel] = useState("");
  const [details, setDetails] = useState("");
  const [rating, setRating] = useState("");
  const [weeks, setWeeks] = useState(4);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [warn, setWarn] = useState<{ flags: Flag[]; warning: string | null }>({ flags: [], warning: null });
  const [err, setErr] = useState<string>();
  const [made, setMade] = useState<{ method: "ai" | "template"; label: string }>();
  const { job, start, busy } = useAiJob((d) => { setBody(d.text); setMade({ method: "ai", label: "AI draft, review before use" }); setWarn({ flags: d.flags, warning: d.warning }); setTitle((t) => t || `${KIND_LABEL[kind]}: ${topic.slice(0, 60)}`); });
  const [offer, setOffer] = useState("");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");
  const [keyPoints, setKeyPoints] = useState("");
  const [cta, setCta] = useState("");
  const [tplBusy, setTplBusy] = useState(false);
  async function fromTemplate() {
    setErr(undefined); setTplBusy(true);
    const r = await api<{ text?: string; label?: string; flags?: Flag[]; warning?: string | null; error?: string }>("template", "POST", {
      kind, offer: offer || (kind === "review_reply" ? "" : topic), audience, tone: tone || undefined, keyPoints, cta, channel,
      reviewText: kind === "review_reply" ? topic : "", rating: kind === "review_reply" ? rating : "", weeks: kind === "content_calendar" ? weeks : undefined,
    });
    setTplBusy(false);
    if (!r.ok || r.data.text === undefined) { setErr(r.data.error ?? "Could not fill the template"); return; }
    setBody(r.data.text); setMade({ method: "template", label: r.data.label ?? "Template draft, review before use" });
    setWarn({ flags: r.data.flags ?? [], warning: r.data.warning ?? null });
    setTitle((t) => t || `${KIND_LABEL[kind]}: ${(offer || topic).slice(0, 60)}`);
  }

  const review = kind === "review_reply";
  async function save() {
    setErr(undefined);
    const r = await api<{ item?: { id: string }; error?: string }>("items", "POST", { kind, title, body, channel, status: "draft" });
    if (!r.ok || !r.data.item) { setErr(r.data.error ?? "Could not save"); return; }
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full page load is intended
    window.location.href = `/app/t/marketing/items/${r.data.item.id}`;
  }
  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Generator">
        {!brandSaved && <p className="text-xs text-amber-300">No brand voice saved yet. Drafts will be generic until you set one on the Brand voice tab.</p>}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm">What to write
            <select className={input} value={kind} onChange={(e) => setKind(e.target.value as ItemKind)}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
          </label>
          <label className="block text-sm">Channel (optional)<input className={input} value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="Instagram, Facebook, newsletter, Google Ads..." /></label>
        </div>
        <label className="block text-sm">{review ? "Paste the customer review" : "Topic or goal"}
          <textarea className={`${input} h-24`} value={topic} onChange={(e) => setTopic(e.target.value)} />
        </label>
        {review && <label className="block text-sm">Star rating (optional)<input className={`${input} max-w-[8rem]`} value={rating} onChange={(e) => setRating(e.target.value)} /></label>}
        {kind === "content_calendar" && <label className="block text-sm">Weeks<input type="number" min={1} max={12} className={`${input} max-w-[8rem]`} value={weeks} onChange={(e) => setWeeks(Number(e.target.value) || 4)} /></label>}
        <label className="block text-sm">Real facts the AI may use (offers, prices, dates, results you can prove)
          <textarea className={`${input} h-20`} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Anything not written here will be left as a [●PLACEHOLDER]" />
        </label>
        <button className={btn} disabled={!canWrite || !aiAvailable || busy || topic.trim().length < 3}
          onClick={() => start("generate", { kind, topic, channel: channel || undefined, details: details || undefined, rating: review ? rating || undefined : undefined, reviewText: review ? topic : undefined, weeks: kind === "content_calendar" ? weeks : undefined })}>
          Draft with AI
        </button>
        {!aiAvailable && <p className="text-xs text-slate-500">AI is not available right now. Use the template questions below, or write copy in the box and save it.</p>}
        <JobStatus job={job} />
        <fieldset className="space-y-3 rounded-lg border border-slate-800 p-3">
          <legend className="px-1 text-sm">Or answer a few plain questions (no AI, instant, never counts against your AI limit)</legend>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm">{review ? "What the business offers (optional)" : "What are you offering?"}<input className={input} value={offer} onChange={(e) => setOffer(e.target.value)} placeholder={review ? "" : "Leave empty to use the topic above"} /></label>
            <label className="block text-sm">Who is it for?<input className={input} value={audience} onChange={(e) => setAudience(e.target.value)} /></label>
            <label className="block text-sm">Tone
              <select className={input} value={tone} onChange={(e) => setTone(e.target.value)}>
                <option value="">From my brand voice</option>{TEMPLATE_TONES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="block text-sm">Call to action<input className={input} value={cta} onChange={(e) => setCta(e.target.value)} placeholder="e.g. Call us to book" /></label>
          </div>
          <label className="block text-sm">Key points (one per line)<textarea className={`${input} h-20`} value={keyPoints} onChange={(e) => setKeyPoints(e.target.value)} /></label>
          <button className={btn2} disabled={!canWrite || tplBusy || (topic.trim().length < 3 && offer.trim().length < 3)} onClick={() => void fromTemplate()}>Write it for me (templates)</button>
        </fieldset>
      </section>
      <section className="space-y-2 rounded-xl border border-slate-800 bg-slate-900 p-4" aria-label="Draft">
        {made && <p className="text-xs font-medium text-amber-300" role="status">{made.method === "ai" ? "Made with AI" : "Made from a template (no AI)"}: {made.label}. Nothing is saved or posted until you save it.</p>}
        <Warnings flags={warn.flags} warning={warn.warning} />
        <label className="block text-sm">Title<input className={input} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="block text-sm">Draft<textarea className={`${input} h-64`} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        {canWrite && <button className={btn} disabled={!title.trim() || !body.trim()} onClick={save}>Save to library</button>}
        {err && <p className="text-sm text-red-300" role="alert">{err}</p>}
      </section>
    </div>
  );
}

function Library({ items }: { items: Item[] }) {
  const [kind, setKind] = useState("all");
  const shown = items.filter((i) => kind === "all" || i.kind === kind);
  return (
    <section className="space-y-3" aria-label="Library">
      <select className={`${input} max-w-xs`} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="all">All kinds</option>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
      {items.length === 0 && <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">Nothing saved yet. Create a draft first.</p>}
      <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900">
        {shown.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
            <a className="font-medium underline" href={`/app/t/marketing/items/${i.id}`}>{i.title}</a>
            <span className="flex gap-2 text-xs text-slate-400"><span>{KIND_LABEL[i.kind as ItemKind] ?? i.kind}</span><span>{i.status}</span>{i.scheduledFor && <span>{i.scheduledFor}</span>}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Calendar() {
  const [items, setItems] = useState<Item[]>();
  useEffect(() => { void api<{ items: Item[] }>("calendar").then((r) => setItems(r.ok ? r.data.items : [])); }, []);
  const groups = new Map<string, Item[]>();
  for (const i of items ?? []) groups.set(i.scheduledFor!, [...(groups.get(i.scheduledFor!) ?? []), i]);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <section className="space-y-3" aria-label="Content calendar">
      <p className="text-sm text-slate-400">Planned dates you set on items. These are reminders only: nothing is posted or sent for you, and no posting accounts are connected. Set a date on an item from the Library.</p>
      {!items && <p className="text-sm text-slate-500">Loading...</p>}
      {items && items.length === 0 && <p className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">No scheduled items yet.</p>}
      {[...groups.entries()].map(([date, list]) => (
        <div key={date} className="rounded-xl border border-slate-800 bg-slate-900 p-3">
          <h3 className={`text-sm font-medium ${date < today ? "text-slate-500" : ""}`}>{new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {list.map((i) => <li key={i.id}><a className="underline" href={`/app/t/marketing/items/${i.id}`}>{i.title}</a> <span className="text-xs text-slate-400">{KIND_LABEL[i.kind as ItemKind] ?? i.kind}{i.channel ? `, ${i.channel}` : ""}, {i.status}</span></li>)}
          </ul>
        </div>
      ))}
    </section>
  );
}
