import { Fragment, useState, type FormEvent } from 'react'
import { api, fmtTime, useQuery, type Matter } from '../api'
import { Empty, Err, Loading } from '../ui'
import { SourceViewer, where } from './Search'
import { CriticPanel } from './Contracts'

type Seg = { text: string; section: string; cites: string[]; status: string; issues: string[]; support: number | null; line: number }
type Quote = { quote: string; status: 'verified' | 'mismatch' | 'user_text'; cite_id?: string; chunk_id?: string; page?: number | null }
type Evidence = {
  cite_id: string; chunk_id: string; title: string; version_number: number; page: number | null; page_end: number | null
  heading_path: string[]; section_number: string; text: string; authority_type: string; authority_label: string
  jurisdiction: string; flags: string[]
}
type Run = {
  id: string; question: string; jurisdiction: string; as_of: string | null; status: string; job_id: string | null
  job_state: string | null; status_message: string; error: string | null; needs_fallback_approval: boolean
  created_at: string; finished_at: string | null
  validation: { unsupported: number; uncited: number; partial: number; supported: number; fabricated_citations: string[]; quotes_verified: number; quotes_failed: number; superseded_cited: number } | null
  answer?: string; model?: string | null; provider?: string | null; prompt_version?: string; output_hash?: string; privacy_mode?: string
  result?: { segments: Seg[]; quotes: Quote[]; evidence: Evidence[]; coverage: { label: string; reason: string }[]; warnings: string[]; regenerated: boolean; critic?: unknown }
  retrieval?: { embedding_model: string; mode: string; chunk_ids: string[]; as_of: string | null }
}

const FLAG_TEXT: Record<string, string> = {
  superseded: 'Superseded', not_in_effect_on_date: 'Not in effect on date', jurisdiction_mismatch: 'Different jurisdiction',
  jurisdiction_unknown: 'Jurisdiction not recorded', negative_treatment: 'Negative treatment recorded', questioned_treatment: 'Treatment questioned',
}
const ISSUE_TEXT: Record<string, string> = {
  claim_without_citation: 'No citation for this statement.', cited_source_does_not_support_claim: 'The cited source does not appear to support this statement.',
  number_not_in_source: 'A number in this statement is not in the cited source.', superseded_authority: 'Cites a superseded source.',
  not_in_effect: 'Cites a source not in effect on the relevant date.', quote_not_found_verbatim: 'A quotation here is not verbatim in any source.',
  quote_from_different_source: 'A quotation here comes from a different source than the one cited.',
}
const issueText = (i: string) => i.startsWith('fabricated_citation:') ? `Cited ${i.split(':')[1]}, which was not a retrieved source (removed).` : (ISSUE_TEXT[i] ?? i)
const STYLE: Record<string, React.CSSProperties> = {
  unsupported: { background: 'var(--bad-soft)', borderRadius: 3 }, invalid_citation: { background: 'var(--bad-soft)', borderRadius: 3 },
  uncited: { background: 'var(--warn-soft)', borderRadius: 3 }, continuation: { borderBottom: '1px dotted var(--muted)' }, partial: { borderBottom: '1.5px dotted var(--warn)' },
}

function SegText({ s, onCite }: { s: Seg; onCite: (id: string) => void }) {
  const parts = s.text.split(/(\[CITE-\d+(?:,\s*CITE-\d+)*\]|\[citation removed[^\]]*\])/g)
  return (
    <span style={STYLE[s.status]} title={s.status === 'continuation' ? 'No citation of its own; continues the cited statement before it.' : s.issues.map(issueText).join(' ')}>
      {parts.map((p, i) => {
        if (p.startsWith('[CITE-')) {
          return <Fragment key={i}>{p.slice(1, -1).split(/,\s*/).map(id => (
            <button key={id} type="button" className="badge accent mono" style={{ border: 0, cursor: 'pointer', margin: '0 1px' }} onClick={() => onCite(id)}>{id}</button>))}</Fragment>
        }
        if (p.startsWith('[citation removed')) return <span key={i} className="badge bad" title="The model cited a source that was not retrieved. The citation was removed.">citation removed</span>
        return <Fragment key={i}>{p}</Fragment>
      })}
      {s.status === 'unsupported' || s.status === 'invalid_citation' || s.status === 'uncited' ? <span aria-label="flagged" title={s.issues.map(issueText).join(' ')}> ⚠</span> : null}{' '}
    </span>
  )
}

function Answer({ run, onCite }: { run: Run; onCite: (id: string) => void }) {
  const segs = run.result?.segments ?? []
  const lines = new Map<number, Seg[]>()
  segs.forEach(s => lines.set(s.line, [...(lines.get(s.line) ?? []), s]))
  return (
    <div>{[...lines.entries()].sort((a, b) => a[0] - b[0]).map(([ln, ss]) =>
      ss[0].text.trimStart().startsWith('#')
        ? <h3 key={ln} style={{ margin: '16px 0 4px' }}>{ss[0].text.replace(/^#+\s*/, '')}</h3>
        : <p key={ln} style={{ margin: '0 0 8px' }}>{ss.map((s, i) => <SegText key={i} s={s} onCite={onCite} />)}</p>)}</div>
  )
}

export function RunView({ id, evidenceOpen }: { id: string; evidenceOpen: (chunkId: string) => void }) {
  const { data: run, reload } = useQuery(() => api<Run>(`/api/research/${id}`), [id], 3000)
  if (!run) return <Loading />
  if (run.status !== 'complete') {
    const failed = ['failed', 'canceled'].includes(run.status)
    return (
      <div className="row wrap small" style={{ padding: '8px 0' }}>
        <span className={`badge ${failed ? 'bad' : run.job_state === 'WAITING_FOR_GPU' ? 'warn' : 'accent'}`}>{failed ? run.status : run.job_state === 'WAITING_FOR_GPU' ? 'Waiting for GPU' : 'Working…'}</span>
        <span className="muted">{run.error ?? run.status_message}</span>
        {!failed && <button className="btn sm danger" onClick={async () => { await api(`/api/jobs/${run.job_id}/cancel`, { method: 'POST' }); reload() }}>Cancel</button>}
        {run.needs_fallback_approval && <button className="btn sm" onClick={async () => { await api(`/api/jobs/${run.job_id}/approve-fallback`, { method: 'POST' }); reload() }}>Approve external fallback</button>}
        {!failed && <span className="spin" />}
      </div>)
  }
  const r = run.result!, v = run.validation!
  const ev = new Map(r.evidence.map(e => [e.cite_id, e]))
  const open = (cid: string) => { const e = ev.get(cid); if (e) evidenceOpen(e.chunk_id) }
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        {r.coverage.map(c => <span key={c.label} title={c.reason} className={`badge ${/^Strong/.test(c.label) ? 'ok' : /^(Moderate)/.test(c.label) ? 'accent' : 'warn'}`}>{c.label}</span>)}
      </div>
      {r.coverage.map(c => <div key={c.label + 'r'} className="muted small">• {c.label}: {c.reason}</div>)}
      {r.warnings.map(w => <div key={w} className="err">{w}</div>)}
      <div className="card"><Answer run={run} onCite={open} />
        <div className="row wrap small muted" style={{ marginTop: 10, gap: 12 }}>
          <span>✓ {v.supported} supported</span>{v.partial > 0 && <span>◐ {v.partial} partly supported</span>}
          {v.unsupported > 0 && <span style={{ color: 'var(--bad)' }}>⚠ {v.unsupported} unsupported</span>}
          {v.uncited > 0 && <span style={{ color: 'var(--warn)' }}>⚠ {v.uncited} uncited</span>}
          {v.fabricated_citations.length > 0 && <span style={{ color: 'var(--bad)' }}>✗ {v.fabricated_citations.length} fake citation(s) removed</span>}
          <span>Quotes: {v.quotes_verified} verified{v.quotes_failed > 0 && <b style={{ color: 'var(--bad)' }}>, {v.quotes_failed} NOT verbatim</b>}</span>
        </div></div>
      <CriticPanel critic={r.critic} />
      {r.quotes.length > 0 && <div className="card stack" style={{ gap: 6 }}><h3>Quotations</h3>
        {r.quotes.map((q, i) => (
          <div key={i} className="row small" style={{ alignItems: 'flex-start' }}>
            <span className={`badge ${q.status === 'mismatch' ? 'bad' : 'ok'}`}>{q.status === 'mismatch' ? 'Not verbatim' : q.status === 'user_text' ? 'From your question' : 'Verified verbatim'}</span>
            <span className="grow">“{q.quote}”</span>
            {q.chunk_id && <button className="btn sm" onClick={() => evidenceOpen(q.chunk_id!)}>{q.cite_id} · view source</button>}
          </div>))}</div>}
      <div className="stack" style={{ gap: 8 }}><h3>Evidence ({r.evidence.length})</h3>
        {r.evidence.map(e => (
          <button key={e.cite_id} className="card" style={{ textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }} onClick={() => evidenceOpen(e.chunk_id)}>
            <div className="row wrap" style={{ gap: 6 }}><span className="badge accent mono">{e.cite_id}</span><strong>{e.title}</strong>
              <span className="badge">{e.authority_type.replace(/_/g, ' ')}</span>
              {e.jurisdiction && <span className="badge">{e.jurisdiction}</span>}
              {e.flags.map(f => <span key={f} className="badge warn">{FLAG_TEXT[f] ?? f}</span>)}</div>
            <div className="muted small" style={{ margin: '4px 0' }}>{where(e) || 'No location'}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{e.text.length > 360 ? e.text.slice(0, 360) + '…' : e.text}</div>
          </button>))}</div>
      <details className="small muted"><summary>Audit record</summary>
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>Model</dt><dd>{run.model} via {run.provider}</dd><dt>Prompt version</dt><dd>{run.prompt_version}</dd>
          <dt>Privacy mode</dt><dd>{run.privacy_mode}</dd><dt>Retrieval</dt><dd>{run.retrieval?.mode} · {run.retrieval?.embedding_model} · {run.retrieval?.chunk_ids.length} passages</dd>
          <dt>Corrected once</dt><dd>{r.regenerated ? 'yes' : 'no'}</dd><dt>Output SHA-256</dt><dd className="mono" style={{ wordBreak: 'break-all' }}>{run.output_hash}</dd></dl></details>
    </div>
  )
}

export default function Research({ m }: { m: Matter }) {
  const runs = useQuery(() => api<Run[]>(`/api/matters/${m.id}/research`), [m.id], 4000)
  const [q, setQ] = useState('')
  const [jur, setJur] = useState('')
  const [asOf, setAsOf] = useState('')
  const [cur, setCur] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const [open, setOpen] = useState<string>()
  const [chunk, setChunk] = useState<string>()
  const canEdit = m.my_role !== 'viewer'

  async function ask(e: FormEvent) {
    e.preventDefault(); if (q.trim().length < 3) return
    setBusy(true); setErr(undefined)
    try {
      const r = await api<Run>('/api/research', { json: { matter_id: m.id, question: q, jurisdiction: jur, as_of: asOf || null, require_current: cur } })
      setQ(''); setOpen(r.id); runs.reload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="stack">
      {canEdit && (
        <form className="card stack" onSubmit={ask}>
          <textarea value={q} onChange={e => setQ(e.target.value)} placeholder="Ask a legal question about this matter's documents and authorities…" style={{ minHeight: 70 }} aria-label="Research question" />
          <div className="row wrap">
            <label style={{ flex: 1, minWidth: 160 }}>Jurisdiction<input value={jur} onChange={e => setJur(e.target.value)} placeholder={m.jurisdiction || 'e.g. Delaware'} /></label>
            <label style={{ flex: 1, minWidth: 160 }}>As of date<input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></label>
            <label className="inline" style={{ alignSelf: 'end', paddingBottom: 8 }}><input type="checkbox" checked={cur} onChange={e => setCur(e.target.checked)} />Current authority only</label>
          </div>
          <Err msg={err} />
          <div className="row between"><span className="muted small">Answers cite only passages retrieved from this matter. Every citation and quotation is checked against the source.</span>
            <button className="btn primary" disabled={busy || q.trim().length < 3}>Research</button></div>
        </form>)}
      {!runs.data ? <Loading /> : runs.data.length === 0 ? <div className="card"><Empty>No research yet. Upload documents, then ask a question.</Empty></div> :
        runs.data.map(r => (
          <div key={r.id} className="card">
            <div className="row between" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === r.id ? undefined : r.id)}
              onKeyDown={e => { if (e.key === 'Enter') setOpen(open === r.id ? undefined : r.id) }}>
              <div className="grow"><strong>{r.question}</strong><div className="muted small">{fmtTime(r.created_at)}{r.jurisdiction && ` · ${r.jurisdiction}`}{r.as_of && ` · as of ${r.as_of}`}</div></div>
              <span className={`badge ${r.status === 'complete' ? 'ok' : ['failed', 'canceled'].includes(r.status) ? 'bad' : 'warn'}`}>{r.status}</span>
            </div>
            {open === r.id && <div style={{ marginTop: 14 }}><RunView id={r.id} evidenceOpen={setChunk} /></div>}
          </div>))}
      {chunk && <SourceViewer chunkId={chunk} onClose={() => setChunk(undefined)} />}
    </div>
  )
}
