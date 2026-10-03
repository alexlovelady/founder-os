import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api, fmtTime, useQuery } from '../api'
import { useCompany } from '../friendly'
import { Err, Loading } from '../ui'
import { RunView } from './Research'
import { SourceViewer } from './Search'

type RunRow = { id: string; question: string; status: string; created_at: string }

const EXAMPLES = [
  'Can a co-founder who leaves keep their unvested shares?',
  'Do I need to register my LLC in another state to do business there?',
  'What does our contract say about ending the agreement early?',
  'Are non-compete clauses enforceable in my state?',
]

export default function Ask() {
  const { company } = useCompany()
  const runs = useQuery(() => (company ? api<RunRow[]>(`/api/matters/${company.id}/research`) : Promise.resolve([] as RunRow[])), [company?.id], 6000)
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string>()
  const [chunk, setChunk] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  if (company === undefined) return <Loading />
  if (company === null) return <div className="card stack"><h2>One quick step first</h2><p>Tell us about your company so answers can use your documents.</p><Link className="btn primary" to="/" style={{ justifySelf: 'start' }}>Set up my workspace</Link></div>
  const state = (company as unknown as { profile?: { state?: string } }).profile?.state ?? ''

  async function ask(e: FormEvent) {
    e.preventDefault(); if (!company || q.trim().length < 3) return
    setBusy(true); setErr(undefined)
    try {
      const r = await api<RunRow>('/api/research', { json: { matter_id: company.id, question: q, jurisdiction: state, as_of: null, require_current: false } })
      setQ(''); setOpen(r.id); runs.reload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="stack" style={{ gap: 18, maxWidth: 860 }}>
      <div><h1>Ask a legal question</h1><p className="muted">Answers come only from your documents and the law library. Every statement shows its source, and anything we cannot support is flagged.</p></div>
      <form className="card stack" onSubmit={ask}>
        <textarea value={q} onChange={e => setQ(e.target.value)} style={{ minHeight: 80 }} aria-label="Your question" placeholder="Type your question in plain English…" />
        <div className="row wrap">{EXAMPLES.map(x => <button key={x} type="button" className="chip" onClick={() => setQ(x)}>{x}</button>)}</div>
        <Err msg={err} />
        <div className="row between"><span className="muted small">{state ? `Using ${state} law where it applies.` : ''}</span><button className="btn primary" disabled={busy || q.trim().length < 3}>Get an answer</button></div>
      </form>
      {!runs.data ? <Loading /> : runs.data.length === 0 ? null : runs.data.map(r => (
        <div key={r.id} className="card">
          <div className="row between" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === r.id ? undefined : r.id)} onKeyDown={e => { if (e.key === 'Enter') setOpen(open === r.id ? undefined : r.id) }}>
            <div className="grow"><strong>{r.question}</strong><div className="muted small">{fmtTime(r.created_at)}</div></div>
            <span className={`badge ${r.status === 'complete' ? 'ok' : ['failed', 'canceled'].includes(r.status) ? 'bad' : 'warn'}`}>{r.status === 'complete' ? 'Answered' : ['failed', 'canceled'].includes(r.status) ? 'Did not work' : 'Working'}</span></div>
          {open === r.id && <div style={{ marginTop: 14 }}><RunView id={r.id} evidenceOpen={setChunk} /></div>}
        </div>))}
      {chunk && <SourceViewer chunkId={chunk} onClose={() => setChunk(undefined)} />}
    </div>
  )
}
