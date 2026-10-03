/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, downloadBlob, useQuery } from '../api'
import { jobText, useCompany } from '../friendly'
import { Err, Loading } from '../ui'

type Field = { key: string; label: string; help: string; kind: 'text' | 'textarea' | 'select' | 'date'; required: boolean; placeholder: string; options: string[]; default: string }
type DocType = { id: string; title: string; blurb: string; perspective: string; fields: Field[]; outline: string[] }
type Catalog = { doc_types: DocType[] }

function Finished({ id, onAgain }: { id: string; onAgain: () => void }) {
  const nav = useNavigate()
  const { data: d, reload } = useQuery(() => api<any>(`/api/drafts/${id}`), [id], 3000)
  const [msg, setMsg] = useState<string>()
  const [err, setErr] = useState<string>()
  if (!d) return <Loading />
  if (d.status !== 'complete') {
    const j = jobText(d.status === 'failed' ? 'FAILED' : d.job_state, d.status_message, 'your document')
    return (
      <div className={`callout ${j.tone === 'bad' ? 'bad' : j.tone === 'wait' ? 'warn' : ''}`}>
        <div className="row">{j.tone === 'work' && <span className="spin" />}<strong>{j.text}</strong></div>
        {d.error && <div className="small">{d.error}</div>}
        {j.tone === 'bad' ? <button className="btn sm" style={{ marginTop: 8 }} onClick={onAgain}>Start over</button>
          : <button className="btn sm danger" style={{ marginTop: 8 }} onClick={async () => { await api(`/api/jobs/${d.job_id}/cancel`, { method: 'POST' }); reload() }}>Cancel</button>}
      </div>)
  }
  const r = d.result
  const left: string[] = r.checks.placeholders_in_text
  const run = async (fn: () => Promise<void>) => { setErr(undefined); setMsg(undefined); try { await fn() } catch (e) { setErr((e as Error).message) } }
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="callout ok"><strong>Your draft is ready.</strong> {left.length > 0 ? `Fill in the ${left.length} highlighted blank${left.length === 1 ? '' : 's'} before using it.` : 'There are no blanks left to fill in.'}</div>
      <div className="row wrap">
        <button className="btn primary" onClick={() => run(async () => { const x = await downloadBlob(`/api/drafts/${id}/download?format=docx`); setMsg(`Downloaded ${x}`) })}>Download Word file</button>
        <button className="btn" onClick={() => run(async () => { await api(`/api/drafts/${id}/save`, { method: 'POST' }); setMsg('Saved to your documents. It now counts on your checklist.') })}>Save to my documents</button>
        <button className="btn" onClick={() => { navigator.clipboard.writeText(d.content); setMsg('Copied to the clipboard.') }}>Copy text</button>
      </div>
      <Err msg={err} />{msg && <div className="badge ok" style={{ justifySelf: 'start' }}>{msg}</div>}
      {r.warnings.map((w: string) => <div key={w} className="err">{w}</div>)}
      <div className="card paper">{d.content.split(/(\[●[^\]]+\])/g).map((p: string, i: number) =>
        p.startsWith('[●') ? <mark key={i}>{p}</mark> : p)}</div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        {r.needs_attorney_review?.length > 0 && <div className="card small"><h3>Have a lawyer check</h3><ul style={{ margin: '6px 0 0 16px', padding: 0 }}>{r.needs_attorney_review.map((a: string) => <li key={a}>{a}</li>)}</ul></div>}
        {r.assumptions?.length > 0 && <div className="card small"><h3>Assumptions we made</h3><ul style={{ margin: '6px 0 0 16px', padding: 0 }}>{r.assumptions.map((a: string) => <li key={a}>{a}</li>)}</ul></div>}
      </div>
      {r.attribution?.length > 0 && <div className="small muted">Structure informed by: {r.attribution.join('; ')}.</div>}
      <p className="muted small">A starting point, not legal advice. Standard agreements are only right if they fit your situation; for equity, tax, or investor documents, have a lawyer review the final version.</p>
      <div className="row"><button className="btn" onClick={onAgain}>Create another document</button><button className="btn" onClick={() => nav('/')}>Back to home</button></div>
    </div>
  )
}

export default function CreateWizard() {
  const { company } = useCompany()
  const [sp] = useSearchParams()
  const cat = useQuery(() => api<Catalog>('/api/startup/catalog'), [])
  const [pick, setPick] = useState<string | undefined>(sp.get('type') ?? undefined)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [draftId, setDraftId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  if (company === undefined || !cat.data) return <Loading />
  if (company === null) return <div className="card stack"><h2>One quick step first</h2><p>Tell us about your company so we can fill in the details for you.</p><Link className="btn primary" to="/" style={{ justifySelf: 'start' }}>Set up my workspace</Link></div>
  const profile = (company as any).profile ?? {}
  const dt = cat.data.doc_types.find(d => d.id === pick)
  const val = (f: Field) => answers[f.key] ?? (f.key === 'company_name' || f.key === 'party_a' ? profile.company_name : f.key === 'state' ? profile.state : undefined) ?? f.default ?? ''
  const reset = () => { setPick(undefined); setDraftId(undefined); setAnswers({}); setErr(undefined) }

  async function submit(e: FormEvent) {
    e.preventDefault(); if (!dt || !company) return
    const full: Record<string, string> = {}
    dt.fields.forEach(f => { full[f.key] = val(f) })
    setBusy(true); setErr(undefined)
    try { const r = await api<any>('/api/drafts', { json: { matter_id: company.id, catalog_id: dt.id, answers: full, critic: false } }); setDraftId(r.id) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="stack" style={{ gap: 18, maxWidth: 860 }}>
      <div><h1>Create a document</h1><p className="muted">Answer a few plain questions. We draft the document using standard structure from the library, with a blank wherever you did not give us a fact.</p></div>
      {draftId ? <Finished id={draftId} onAgain={reset} /> : !dt ? (
        <div className="choices wide">{cat.data.doc_types.map(d => (
          <button key={d.id} className="choice" onClick={() => setPick(d.id)}><strong>{d.title}</strong><span className="small muted">{d.blurb}</span></button>))}</div>
      ) : (
        <form className="card stack" onSubmit={submit}>
          <div className="row between"><div><h2>{dt.title}</h2><div className="muted small">{dt.blurb}</div></div><button type="button" className="btn sm" onClick={reset}>Change</button></div>
          {dt.fields.map(f => (
            <label key={f.key}><span>{f.label}{f.required && <span style={{ color: 'var(--bad)' }}> *</span>}</span>
              {f.kind === 'textarea' ? <textarea value={val(f)} placeholder={f.placeholder} required={f.required} onChange={e => setAnswers({ ...answers, [f.key]: e.target.value })} />
                : f.kind === 'select' ? <select value={val(f)} onChange={e => setAnswers({ ...answers, [f.key]: e.target.value })}>{f.options.map(o => <option key={o}>{o}</option>)}</select>
                  : <input type={f.kind === 'date' ? 'date' : 'text'} value={val(f)} placeholder={f.placeholder} required={f.required} onChange={e => setAnswers({ ...answers, [f.key]: e.target.value })} />}
              {f.help && <span className="tip">{f.help}</span>}</label>))}
          <details className="small"><summary>What will be in it</summary><ol style={{ margin: '6px 0 0 18px', padding: 0 }}>{dt.outline.map(o => <li key={o}>{o}</li>)}</ol></details>
          <Err msg={err} />
          <div><button className="btn primary" disabled={busy}>{busy ? 'Starting…' : 'Create my document'}</button></div>
        </form>)}
    </div>
  )
}
