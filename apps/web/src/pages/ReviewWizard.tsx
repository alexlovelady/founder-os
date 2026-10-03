/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, downloadPost, useQuery, type Doc } from '../api'
import { PERSPECTIVES, RISK_WORDS, jobText, overallRisk, useCompany } from '../friendly'
import { Err, Loading } from '../ui'
import { CriticPanel } from './Contracts'

const RISK_CLS: Record<string, string> = { critical: 'bad', high: 'bad', medium: 'warn', low: '', informational: '' }

function Result({ reviewId, matterId }: { reviewId: string; matterId: string }) {
  const { data: rv, reload } = useQuery(() => api<any>(`/api/contracts/reviews/${reviewId}`), [reviewId], 3000)
  const reds = useQuery(() => api<any[]>(`/api/matters/${matterId}/redlines`), [matterId], 5000)
  const [msg, setMsg] = useState<string>()
  const [err, setErr] = useState<string>()
  if (!rv) return <Loading />
  if (rv.status !== 'complete') {
    const j = jobText(rv.status === 'failed' ? 'FAILED' : rv.job_state, rv.status_message, 'your review')
    return (
      <div className={`callout ${j.tone === 'bad' ? 'bad' : j.tone === 'wait' ? 'warn' : ''}`}>
        <div className="row">{j.tone === 'work' && <span className="spin" />}<strong>{j.text}</strong></div>
        {rv.error && <div className="small">{rv.error}</div>}
        {j.tone !== 'bad' && <div className="small muted">A careful review of a long contract can take a few minutes. You can leave this page; it will be under Activity.</div>}
        {j.tone !== 'bad' && <button className="btn sm danger" style={{ marginTop: 8 }} onClick={async () => { await api(`/api/jobs/${rv.job_id}/cancel`, { method: 'POST' }); reload() }}>Cancel</button>}
      </div>)
  }
  const r = rv.result, plain = r.plain
  const risk = overallRisk(r.risk_counts)
  const myReds = (reds.data ?? []).filter(x => x.document_id === rv.document_id)
  const clause = new Map<string, any>(r.clauses.map((c: any) => [c.id, c]))
  const download = async () => {
    setErr(undefined); setMsg(undefined)
    try {
      const x = await downloadPost(`/api/documents/${rv.document_id}/revise`, { format: 'tracked_docx', include_pending: true, save_as_version: false })
      setMsg(`Downloaded ${x.filename}. Open it in Word to accept or reject each change.`)
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className={`verdict ${risk.cls}`}><div className="small">Overall</div><div className="big">{risk.label}</div>
        <div className="small">{r.issues.length === 0 ? 'No issues were raised.' : `${r.issues.length} thing${r.issues.length === 1 ? '' : 's'} to look at, most important first.`}</div></div>
      {r.warnings.map((w: string) => <div key={w} className="err">{w}</div>)}
      {plain?.summary && <div className="card stack"><h2>What this contract says</h2><p style={{ margin: 0, lineHeight: 1.6 }}>{plain.summary}</p>
        {plain.key_terms.length > 0 && <dl className="kv">{plain.key_terms.map((t: any, i: number) => <div key={i} style={{ display: 'contents' }}><dt>{t.label}</dt>
          <dd>{t.value} {t.verified ? <span className="badge ok" title="This wording was found in the contract text">checked</span> : <span className="badge warn" title="Could not find this exact wording in the contract. Check it yourself.">verify</span>}</dd></div>)}</dl>}</div>}
      {plain?.watch_outs?.length > 0 && <div className="card stack"><h2>Watch out for</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>{plain.watch_outs.map((w: any, i: number) => <li key={i}>{w.text}{w.clause && clause.get(w.clause) && <details className="small muted"><summary>See the clause</summary><div style={{ whiteSpace: 'pre-wrap' }}>{clause.get(w.clause).text}</div></details>}</li>)}</ul></div>}
      <div className="stack"><h2>Issues, most important first</h2>
        {r.issues.length === 0 && <div className="card muted">Nothing stood out. Still read it before you sign.</div>}
        {r.issues.map((i: any) => (
          <div key={i.id} className="card stack" style={{ gap: 8 }}>
            <div className="row wrap" style={{ gap: 8 }}><span className={`badge ${RISK_CLS[i.risk] ?? ''}`}>{RISK_WORDS[i.risk] ?? i.risk}</span><strong>{i.title}</strong></div>
            <div>{i.why}</div>
            {i.quote && <blockquote className="quote">“{i.quote}”</blockquote>}
            {i.suggested_revision && <details><summary>Suggested replacement wording</summary><div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{i.suggested_revision}</div></details>}
          </div>))}</div>
      {plain?.questions_to_ask?.length > 0 && <div className="card stack"><h2>Questions to ask the other side</h2><ul style={{ margin: 0, paddingLeft: 18 }}>{plain.questions_to_ask.map((q: string) => <li key={q}>{q}</li>)}</ul></div>}
      {r.missing_terms.length > 0 && <div className="card stack"><h2>Missing from this contract</h2><div className="small muted">Topics that contracts like this usually cover and this one does not mention.</div>
        <div className="row wrap">{r.missing_terms.map((t: string) => <span key={t} className="badge warn">{t.replace(/_/g, ' ')}</span>)}</div></div>}
      <div className="card stack"><h2>Send it back with your changes</h2>
        <p className="muted small" style={{ margin: 0 }}>{myReds.length > 0 ? `${myReds.length} suggested change${myReds.length === 1 ? '' : 's'} ready.` : 'Suggested changes are being prepared…'} The file keeps your original formatting and shows each change as a tracked change in Word.</p>
        <div className="row wrap"><button className="btn primary" onClick={download} disabled={myReds.length === 0}>Download Word file with changes</button>
          <Link className="btn" to={`/matters/${matterId}/redlines`}>Review changes one by one</Link></div>
        <Err msg={err} />{msg && <div className="badge ok" style={{ justifySelf: 'start' }}>{msg}</div>}</div>
      <CriticPanel critic={r.critic} />
      <p className="muted small">This is AI-assisted and can miss things. For anything large or unusual, have a lawyer read it. Reviewed privately on your own computer.</p>
    </div>
  )
}

export default function ReviewWizard() {
  const { company } = useCompany()
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [file, setFile] = useState<File>()
  const [persp, setPersp] = useState<string>('customer')
  const [docId, setDocId] = useState<string>()
  const [reviewId, setReviewId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const docs = useQuery(() => (company ? api<Doc[]>(`/api/matters/${company.id}/documents`) : Promise.resolve([] as Doc[])), [company?.id], docId && !reviewId ? 2000 : 0)
  const mine = docs.data?.find(d => d.id === docId)
  const parse = mine?.current_version?.parse_status
  // Start automatically once the upload has been read.
  useEffect(() => { if (step === 3 && docId && parse === 'parsed' && !reviewId && !busy && !err) start() }, [step, docId, parse, reviewId]) // eslint-disable-line react-hooks/exhaustive-deps
  if (company === undefined) return <Loading />
  if (company === null) return <div className="card stack"><h2>One quick step first</h2><p>Tell us about your company so we know where to keep your documents.</p><Link className="btn primary" to="/" style={{ justifySelf: 'start' }}>Set up my workspace</Link></div>

  async function go() {
    if (!file || !company) return
    setBusy(true); setErr(undefined)
    try {
      const form = new FormData(); form.append('matter_id', company.id); form.append('file', file)
      const d = await api<any>('/api/documents', { form })
      setDocId(d.id ?? d.document?.id ?? d.document_id); setStep(3)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  async function start() {
    if (!docId) return
    setBusy(true); setErr(undefined)
    try { const r = await api<any>('/api/contracts/review', { json: { document_id: docId, perspective: persp, critic: false } }); setReviewId(r.id) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="stack" style={{ gap: 18, maxWidth: 860 }}>
      <div><h1>Review a contract</h1><p className="muted">Upload a contract you were sent. You will get a plain-English summary, the risks, and a Word file with suggested changes.</p></div>
      <div className="steps"><span className={step >= 1 ? 'on' : ''}>1. Upload</span><span className={step >= 2 ? 'on' : ''}>2. Your side</span><span className={step >= 3 ? 'on' : ''}>3. Results</span></div>
      {step === 1 && <div className="stack">
        <div className={`drop ${over ? 'over' : ''}`} role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={e => { if (e.key === 'Enter') input.current?.click() }}
          onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) { setFile(f); setStep(2) } }}>
          <strong>Drop the contract here</strong> or click to choose a file<div className="small">Word, PDF, or a photo or scan of a page. Up to 50 MB.</div></div>
        <input ref={input} type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) { setFile(f); setStep(2) } e.target.value = '' }} />
        <p className="muted small">Your file stays in your private workspace and is never used to train anything.</p></div>}
      {step === 2 && <div className="stack">
        <div className="card row between"><div><strong>{file?.name}</strong><div className="muted small">{file && `${(file.size / 1024).toFixed(0)} KB`}</div></div><button className="btn sm" onClick={() => { setFile(undefined); setStep(1) }}>Choose a different file</button></div>
        <h2>Which side are you on?</h2><p className="muted small" style={{ marginTop: -8 }}>The same clause can be good for one side and bad for the other.</p>
        <div className="choices">{PERSPECTIVES.map(p => <button key={p.id} type="button" className={`choice ${persp === p.id ? 'on' : ''}`} onClick={() => setPersp(p.id)}><strong>{p.title}</strong><span className="small muted">{p.blurb}</span></button>)}</div>
        <Err msg={err} /><div><button className="btn primary" disabled={busy} onClick={go}>{busy ? 'Uploading…' : 'Review it'}</button></div></div>}
      {step === 3 && !reviewId && !err && <div className="callout"><div className="row"><span className="spin" /><strong>{parse === 'failed' ? 'We could not read this file.' : 'Reading your document…'}</strong></div>
        {parse === 'failed' && <div className="small">Try a Word or text-based PDF, or a clearer scan.</div>}</div>}
      {step === 3 && err && <Err msg={err} />}
      {reviewId && company && <Result reviewId={reviewId} matterId={company.id} />}
      {reviewId && <div><button className="btn" onClick={() => { setStep(1); setFile(undefined); setDocId(undefined); setReviewId(undefined) }}>Review another contract</button></div>}
    </div>
  )
}
