/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react'
import { api, fmtTime, useQuery, type Matter } from '../api'
import { Empty, Err, Loading } from '../ui'
import { CriticPanel } from './Contracts'

const MODES: Record<string, string> = {
  draft_from_scratch: 'Draft from scratch', rewrite_clause: 'Rewrite a clause', favor_company: 'More company-friendly', favor_counterparty: 'More counterparty-friendly',
  balanced: 'Neutral / balanced rewrite', simplify: 'Simplify language', add_missing: 'Add missing provisions', alternatives: 'Negotiation alternatives',
}
const NEEDS_SOURCE = (m: string) => !['draft_from_scratch', 'add_missing'].includes(m)

function DraftView({ id }: { id: string }) {
  const { data: d, reload } = useQuery(() => api<any>(`/api/drafts/${id}`), [id], 3000)
  const [copied, setCopied] = useState(false)
  if (!d) return <Loading />
  if (d.status !== 'complete') {
    const failed = ['failed', 'canceled'].includes(d.status)
    return <div className="row wrap small"><span className={`badge ${failed ? 'bad' : d.job_state === 'WAITING_FOR_GPU' ? 'warn' : 'accent'}`}>{failed ? d.status : d.job_state === 'WAITING_FOR_GPU' ? 'Waiting for GPU' : 'Drafting…'}</span>
      <span className="muted">{d.error ?? d.status_message}</span>{!failed && <button className="btn sm danger" onClick={async () => { await api(`/api/jobs/${d.job_id}/cancel`, { method: 'POST' }); reload() }}>Cancel</button>}</div>
  }
  const r = d.result, chk = r.checks
  return (
    <div className="stack" style={{ gap: 12 }}>
      {r.warnings.map((w: string) => <div key={w} className="err">{w}</div>)}
      <div className="card"><div className="row between"><h3>Draft</h3><button className="btn sm" onClick={() => { navigator.clipboard.writeText(d.content); setCopied(true) }}>{copied ? 'Copied' : 'Copy text'}</button></div>
        <div style={{ whiteSpace: 'pre-wrap', marginTop: 8, lineHeight: 1.6 }}>{d.content.split(/(\[●[^\]]+\])/g).map((p: string, i: number) =>
          p.startsWith('[●') ? <mark key={i} style={{ background: 'var(--warn-soft)', color: 'inherit', borderRadius: 3 }}>{p}</mark> : p)}</div></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div className="card small"><h3>Fill in before use ({chk.placeholders_in_text.length})</h3>
          {chk.placeholders_in_text.length === 0 ? <div className="muted">No placeholders.</div> : <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>{chk.placeholders_in_text.map((p: string) => <li key={p}><span className="mono">{p}</span> {r.placeholders.find((x: any) => p === `[●${x.name}]`)?.description}</li>)}</ul>}</div>
        <div className="card small"><h3>Assumptions</h3><ul style={{ margin: '6px 0 0 16px', padding: 0 }}>{r.assumptions.length ? r.assumptions.map((a: string) => <li key={a}>{a}</li>) : <li className="muted">None stated.</li>}</ul></div>
        <div className="card small"><h3>Needs attorney review</h3><ul style={{ margin: '6px 0 0 16px', padding: 0 }}>{r.needs_attorney_review.length ? r.needs_attorney_review.map((a: string) => <li key={a}>{a}</li>) : <li className="muted">Nothing flagged — review it anyway.</li>}</ul></div>
        <div className="card small"><h3>Checked by software</h3>
          <div style={{ marginTop: 6 }}><strong>Specifics you did not provide:</strong> {chk.unverified_specifics.length ? chk.unverified_specifics.join(', ') : 'none'}</div>
          <div><strong>Undefined terms:</strong> {chk.undefined_terms.length ? chk.undefined_terms.map((u: any) => u.term).join(', ') : 'none'}</div>
          <div><strong>Broken cross-references:</strong> {chk.broken_cross_references.length ? chk.broken_cross_references.map((b: any) => b.reference).join(', ') : 'none'}</div></div>
      </div>
      <CriticPanel critic={r.critic} />
      <div className="muted small">Model {d.model} · prompt {d.prompt_version} · output {d.output_hash?.slice(0, 12)}…. A draft is a starting point for a lawyer, not a finished or legally sufficient document.</div>
    </div>
  )
}

export default function Draft({ m }: { m: Matter }) {
  const list = useQuery(() => api<any[]>(`/api/matters/${m.id}/drafts`), [m.id], 4000)
  const [mode, setMode] = useState('draft_from_scratch')
  const [docType, setDocType] = useState('')
  const [instr, setInstr] = useState('')
  const [source, setSource] = useState('')
  const [jur, setJur] = useState('')
  const [persp, setPersp] = useState('neutral')
  const [facts, setFacts] = useState<{ k: string; v: string }[]>([{ k: '', v: '' }])
  const [critic, setCritic] = useState(false)
  const [open, setOpen] = useState<string>()
  const [err, setErr] = useState<string>()
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(undefined)
    try {
      const r = await api<any>('/api/drafts', { json: { matter_id: m.id, mode, doc_type: docType, instructions: instr, source_text: source, jurisdiction: jur, perspective: persp, critic,
        facts: Object.fromEntries(facts.filter(f => f.k.trim() && f.v.trim()).map(f => [f.k.trim(), f.v.trim()])) } })
      setOpen(r.id); list.reload()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="stack">
      {m.my_role !== 'viewer' && (
        <form className="card stack" onSubmit={go}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <label>Task<select value={mode} onChange={e => setMode(e.target.value)}>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label>Document type<input value={docType} onChange={e => setDocType(e.target.value)} placeholder="e.g. Mutual NDA" /></label>
            <label>Jurisdiction<input value={jur} onChange={e => setJur(e.target.value)} placeholder={m.jurisdiction || 'e.g. Delaware'} /></label>
            <label>Perspective<select value={persp} onChange={e => setPersp(e.target.value)}>{['neutral', 'customer', 'vendor', 'employer', 'employee'].map(p => <option key={p}>{p}</option>)}</select></label>
          </div>
          <label>Instructions<textarea value={instr} onChange={e => setInstr(e.target.value)} placeholder="What should be drafted, and any positions to take…" required minLength={3} /></label>
          {NEEDS_SOURCE(mode) && <label>Source text<textarea value={source} onChange={e => setSource(e.target.value)} placeholder="Paste the clause to rewrite…" /></label>}
          <div className="stack" style={{ gap: 6 }}><span style={{ fontWeight: 600, fontSize: 13 }}>Facts you are providing (anything not listed becomes a placeholder)</span>
            {facts.map((f, i) => <div key={i} className="row"><input placeholder="Name (e.g. Client)" value={f.k} onChange={e => setFacts(facts.map((x, j) => j === i ? { ...x, k: e.target.value } : x))} />
              <input placeholder="Value (e.g. Acme Inc.)" value={f.v} onChange={e => setFacts(facts.map((x, j) => j === i ? { ...x, v: e.target.value } : x))} /></div>)}
            <div><button type="button" className="btn sm" onClick={() => setFacts([...facts, { k: '', v: '' }])}>Add fact</button></div></div>
          <label className="inline"><input type="checkbox" checked={critic} onChange={e => setCritic(e.target.checked)} />Run a second-pass critic</label>
          <Err msg={err} /><div><button className="btn primary">Draft</button></div>
        </form>)}
      {!list.data ? <Loading /> : list.data.length === 0 ? <div className="card"><Empty>No drafts yet.</Empty></div> : list.data.map(d => (
        <div key={d.id} className="card">
          <div className="row between" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === d.id ? undefined : d.id)} onKeyDown={e => { if (e.key === 'Enter') setOpen(open === d.id ? undefined : d.id) }}>
            <div className="grow"><strong>{MODES[d.mode] ?? d.mode}{d.doc_type && ` · ${d.doc_type}`}</strong><div className="muted small">{d.instructions.slice(0, 120)} · {fmtTime(d.created_at)}</div></div>
            <span className={`badge ${d.status === 'complete' ? 'ok' : ['failed', 'canceled'].includes(d.status) ? 'bad' : 'warn'}`}>{d.status}</span></div>
          {open === d.id && <div style={{ marginTop: 14 }}><DraftView id={d.id} /></div>}
        </div>))}
    </div>
  )
}
