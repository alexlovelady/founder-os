/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react'
import { api, downloadPost, fmtTime, useQuery, type Doc, type Matter, type Version } from '../api'
import { Link } from 'react-router-dom'
import { Empty, Err, Loading } from '../ui'

export function DiffView({ ops }: { ops: { op: string; text: string }[] }) {
  return (
    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>
      {ops.map((o, i) => o.op === 'equal' ? <span key={i}>{o.text}</span>
        : o.op === 'insert' ? <ins key={i} style={{ background: 'var(--ok-soft)', color: 'var(--ok)', textDecoration: 'none', borderRadius: 3 }}>{o.text}</ins>
          : <del key={i} style={{ background: 'var(--bad-soft)', color: 'var(--bad)', borderRadius: 3 }}>{o.text}</del>)}
    </div>
  )
}

const RISK_CLS: Record<string, string> = { critical: 'bad', high: 'bad', medium: 'warn', low: '', informational: '' }
const RiskBadge = ({ r }: { r: string }) => <span className={`badge ${RISK_CLS[r] ?? ''}`} style={r === 'critical' ? { fontWeight: 800 } : undefined}>{r}</span>
const cap = (s: string) => s.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())

export function CriticPanel({ critic }: { critic: any }) {
  if (!critic) return null
  const f: any[] = critic.findings ?? []
  return (
    <div className="card stack" style={{ gap: 6 }}>
      <h3>Second-pass review {f.length ? `(${f.length} finding${f.length > 1 ? 's' : ''})` : ''}</h3>
      {f.length === 0 && <span className="muted small">The critic found no problems it could verify.</span>}
      {f.map((x, i) => (
        <div key={i} className="small" style={{ borderLeft: `3px solid ${x.severity === 'high' ? 'var(--bad)' : x.severity === 'medium' ? 'var(--warn)' : 'var(--line)'}`, paddingLeft: 10 }}>
          <div className="row wrap" style={{ gap: 6 }}><span className={`badge ${x.severity === 'high' ? 'bad' : x.severity === 'medium' ? 'warn' : ''}`}>{x.severity}</span>
            <strong>{cap(x.type)}</strong><span className="badge">{x.source === 'deterministic' ? 'checked by software' : 'model finding, location verified'}</span></div>
          {x.quote && <div className="muted" style={{ margin: '4px 0' }}>“{x.quote}”</div>}
          <div>{x.explanation}</div>
        </div>))}
      {critic.dropped_unverifiable > 0 && <span className="muted small">{critic.dropped_unverifiable} model finding(s) were discarded because they could not be verified against the text.</span>}
    </div>
  )
}

function ReviewDetail({ id, m }: { id: string; m: Matter }) {
  const { data: rv, reload } = useQuery(() => api<any>(`/api/contracts/reviews/${id}`), [id], 3000)
  const [open, setOpen] = useState<string>()
  const [msg, setMsg] = useState<string>()
  if (!rv) return <Loading />
  if (rv.status !== 'complete') {
    const failed = ['failed', 'canceled'].includes(rv.status)
    return <div className="row wrap small"><span className={`badge ${failed ? 'bad' : rv.job_state === 'WAITING_FOR_GPU' ? 'warn' : 'accent'}`}>{failed ? rv.status : rv.job_state === 'WAITING_FOR_GPU' ? 'Waiting for GPU' : 'Reviewing…'}</span>
      <span className="muted">{rv.error ?? rv.status_message}</span>{!failed && <><button className="btn sm danger" onClick={async () => { await api(`/api/jobs/${rv.job_id}/cancel`, { method: 'POST' }); reload() }}>Cancel</button><span className="spin" /></>}</div>
  }
  const r = rv.result
  const clauseById = new Map<string, any>(r.clauses.map((c: any) => [c.id, c]))
  const rc = r.risk_counts as Record<string, number>
  async function altRedline(clauseId: string) {
    const c = clauseById.get(clauseId)
    try { await api('/api/redlines', { json: { chunk_id: c.chunk_id, instruction: 'Propose a balanced alternative that addresses the issue', perspective: r.perspective } }); setMsg('Redline requested — see the Redlines section.') }
    catch (e) { setMsg((e as Error).message) }
  }
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="badge">{cap(r.agreement_type)}</span><span className="badge">{r.perspective} perspective</span>{r.playbook && <span className="badge accent" title={r.playbook_auto ? 'Matched to the document type automatically' : ''}>Playbook: {r.playbook}{r.playbook_auto ? ' (auto)' : ''}</span>}
        {Object.entries(rc).filter(([, n]) => n > 0).map(([k, n]) => <span key={k} className={`badge ${RISK_CLS[k] ?? ''}`}>{n} {k}</span>)}
        <span className="badge">{r.obligation_count} obligations extracted</span>
      </div>
      {r.warnings.map((w: string) => <div key={w} className="err">{w}</div>)}
      {msg && <div className="card small">{msg}</div>}
      <h3>Issues for your judgment ({r.issues.length})</h3>
      {r.issues.length === 0 && <Empty>No issues were raised.</Empty>}
      {r.issues.map((i: any) => (
        <div key={i.id} className="card stack" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 6 }}><RiskBadge r={i.risk} /><strong>{i.title}</strong><span className="badge">{cap(i.basis)}</span>{i.favors !== 'unclear' && <span className="badge">favors {i.favors}</span>}</div>
          <div>{i.why}</div>
          {i.quote && <div className="small"><span className="badge ok">Verified verbatim</span> <span className="muted">“{i.quote}”</span></div>}
          <div className="row wrap" style={{ gap: 6 }}>{i.clauses.map((c: string) => <button key={c} className="badge accent mono" style={{ border: 0, cursor: 'pointer' }} onClick={() => setOpen(open === c ? undefined : c)}>{c}</button>)}
            {i.clauses.length === 1 && <button className="btn sm" onClick={() => altRedline(i.clauses[0])}>Another redline</button>}</div>
          {i.clauses.includes(open) && <div className="card small" style={{ background: 'var(--soft)', whiteSpace: 'pre-wrap' }}>{clauseById.get(open!)?.text}</div>}
          {i.suggested_revision && <div className="small"><div className="muted">Suggested replacement (proposal — see Redlines for the tracked change):</div><div style={{ whiteSpace: 'pre-wrap' }}>{i.suggested_revision}</div></div>}
        </div>))}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div className="card small"><h3>Checked by software</h3>
          <div style={{ marginTop: 6 }}><strong>Missing topics:</strong> {r.missing_terms.length ? r.missing_terms.map(cap).join(', ') : 'none'}</div>
          <div><strong>Defined terms never defined:</strong> {r.undefined_terms.length ? r.undefined_terms.map((u: any) => `${u.term} (${u.uses}×)`).join(', ') : 'none found'}</div>
          <div><strong>Defined but unused:</strong> {r.unused_definitions.length ? r.unused_definitions.join(', ') : 'none'}</div>
          <div><strong>Broken cross-references:</strong> {r.broken_cross_references.length ? r.broken_cross_references.map((b: any) => b.reference).join(', ') : 'none'}</div></div>
        <div className="card small"><h3>Key figures</h3>
          <div style={{ marginTop: 6 }}><strong>Money:</strong> {r.figures.money.join(', ') || '—'}</div><div><strong>Time periods:</strong> {r.figures.durations.join(', ') || '—'}</div><div><strong>Percentages:</strong> {r.figures.percents.join(', ') || '—'}</div></div>
      </div>
      <CriticPanel critic={r.critic} />
      <details className="small"><summary>All clauses ({r.clauses.length})</summary>
        <table style={{ marginTop: 8 }}><thead><tr><th>ID</th><th>Where</th><th>Topic</th><th>Summary</th></tr></thead><tbody>
          {r.clauses.map((c: any) => <tr key={c.id}><td className="mono">{c.id}</td><td className="small">{c.heading_path.join(' › ') || c.section}</td><td>{cap(c.topic)}</td><td>{c.summary || <span className="muted">{c.text.slice(0, 100)}…</span>}{c.unusual && <div className="small" style={{ color: 'var(--warn)' }}>⚠ {c.unusual}</div>}</td></tr>)}</tbody></table></details>
      <div className="muted small">Model {rv.model} · prompt {rv.prompt_version} · output {rv.output_hash?.slice(0, 12)}… · {m.privacy_mode}. Suggestions are proposals for a lawyer to evaluate, not legal advice.</div>
    </div>
  )
}

function Reviews({ m }: { m: Matter }) {
  const list = useQuery(() => api<any[]>(`/api/matters/${m.id}/contract-reviews`), [m.id], 4000)
  const docs = useQuery(() => api<Doc[]>(`/api/matters/${m.id}/documents`), [m.id])
  const pbs = useQuery(() => api<any[]>('/api/playbooks'), [])
  const [doc, setDoc] = useState('')
  const [pb, setPb] = useState('')
  const [persp, setPersp] = useState('neutral')
  const [critic, setCritic] = useState(false)
  const [open, setOpen] = useState<string>()
  const [err, setErr] = useState<string>()
  const ready = (docs.data ?? []).filter(d => d.current_version?.parse_status === 'parsed')
  async function start(e: FormEvent) {
    e.preventDefault(); setErr(undefined)
    try { const r = await api<any>('/api/contracts/review', { json: { document_id: doc || ready[0]?.id, playbook_id: pb || null, perspective: persp, critic } }); setOpen(r.id); list.reload() }
    catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="stack">
      {m.my_role !== 'viewer' && (
        <form className="card stack" onSubmit={start}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <label>Document<select value={doc} onChange={e => setDoc(e.target.value)}>{ready.length === 0 && <option>No parsed documents yet</option>}{ready.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
            <label>Playbook<select value={pb} onChange={e => setPb(e.target.value)}><option value="">None — general reasonableness</option>{(pbs.data ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>Perspective<select value={persp} onChange={e => setPersp(e.target.value)}>{['neutral', 'customer', 'vendor', 'employer', 'employee'].map(p => <option key={p}>{p}</option>)}</select></label>
          </div>
          <label className="inline"><input type="checkbox" checked={critic} onChange={e => setCritic(e.target.checked)} />Run a second-pass critic on the issue list</label>
          <Err msg={err} /><div className="row between"><span className="muted small">Differences from a playbook are flagged for your judgment, not called “bad”.</span><button className="btn primary" disabled={ready.length === 0}>Review contract</button></div>
        </form>)}
      {!list.data ? <Loading /> : list.data.length === 0 ? <div className="card"><Empty>No contract reviews yet.</Empty></div> : list.data.map(r => (
        <div key={r.id} className="card">
          <div className="row between" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setOpen(open === r.id ? undefined : r.id)} onKeyDown={e => { if (e.key === 'Enter') setOpen(open === r.id ? undefined : r.id) }}>
            <div><strong>{r.document_title}</strong><div className="muted small">{fmtTime(r.created_at)} · {r.perspective}</div></div>
            <div className="row" style={{ gap: 6 }}>{r.risk_counts && Object.entries(r.risk_counts as Record<string, number>).filter(([, n]) => n > 0).slice(0, 3).map(([k, n]) => <span key={k} className={`badge ${RISK_CLS[k] ?? ''}`}>{n} {k}</span>)}
              <span className={`badge ${r.status === 'complete' ? 'ok' : ['failed', 'canceled'].includes(r.status) ? 'bad' : 'warn'}`}>{r.status}</span></div></div>
          {open === r.id && <div style={{ marginTop: 14 }}><ReviewDetail id={r.id} m={m} /></div>}
        </div>))}
    </div>
  )
}

function RevisePanel({ m, redlines }: { m: Matter; redlines: any[] }) {
  const docs = useQuery(() => api<Doc[]>(`/api/matters/${m.id}/documents`), [m.id])
  const withRedlines = (docs.data ?? []).filter(d => redlines.some(r => r.document_id === d.id))
  const [docId, setDocId] = useState('')
  const did = docId || withRedlines[0]?.id
  const [fmt, setFmt] = useState('tracked_docx')
  const [pending, setPending] = useState(false)
  const [save, setSave] = useState(false)
  const [pv, setPv] = useState<any>()
  const [msg, setMsg] = useState<string>()
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  if (withRedlines.length === 0) return null
  const body = { format: fmt, include_pending: pending, save_as_version: save }
  const wrap = async (fn: () => Promise<void>) => { setErr(undefined); setMsg(undefined); setBusy(true); try { await fn() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) } }
  return (
    <div className="card stack">
      <div><h3>Create the revised document</h3><div className="muted small">Applies the accepted redlines to your uploaded document. Word files are edited in place, so formatting is kept.</div></div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
        <label>Document<select value={did} onChange={e => { setDocId(e.target.value); setPv(undefined) }}>{withRedlines.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
        <label>Format<select value={fmt} onChange={e => setFmt(e.target.value)}>
          <option value="tracked_docx">Word with tracked changes (accept or reject in Word)</option><option value="docx">Word, clean revised copy</option><option value="txt">Plain text</option><option value="md">Markdown</option></select></label></div>
      <div className="row wrap"><label className="inline"><input type="checkbox" checked={pending} onChange={e => { setPending(e.target.checked); setPv(undefined) }} />Also apply suggestions I have not decided on yet</label>
        <label className="inline"><input type="checkbox" checked={save} onChange={e => setSave(e.target.checked)} />Save as a new version of this document instead of downloading</label></div>
      <div className="row wrap"><button className="btn" disabled={busy} onClick={() => wrap(async () => setPv(await api<any>(`/api/documents/${did}/revise/preview`, { json: body })))}>Preview what will change</button>
        <button className="btn primary" disabled={busy} onClick={() => wrap(async () => {
          if (save) { const r = await api<any>(`/api/documents/${did}/revise`, { json: body }); setMsg(`Saved as version ${r.version_number} (${r.applied} change${r.applied === 1 ? '' : 's'} applied). It is being re-indexed.`) }
          else { const r = await downloadPost(`/api/documents/${did}/revise`, body); setMsg(`Downloaded ${r.filename} (${r.applied} change${r.applied === '1' ? '' : 's'} applied).`) }
        })}>{save ? 'Save revised version' : 'Download'}</button></div>
      <Err msg={err} />{msg && <div className="badge ok" style={{ justifySelf: 'start' }}>{msg}</div>}
      {pv && <div className="stack small" style={{ gap: 6 }}>
        <div><strong>{pv.applied.length}</strong> change{pv.applied.length === 1 ? '' : 's'} will be applied{pv.pending_not_applied > 0 && <> · <span style={{ color: 'var(--warn)' }}>{pv.pending_not_applied} pending suggestion(s) not included</span></>}{!pv.preserves_formatting && <> · <span className="muted">this file type is rebuilt as a new Word document, so its original layout is not preserved</span></>}</div>
        {pv.skipped.map((s: any) => <div key={s.redline_id} className="err">Skipped {s.label || 'a clause'}: {s.reason}</div>)}
        {pv.needs_manual_drafting.length > 0 && <div className="card" style={{ background: 'var(--soft)' }}><strong>Recommendations that need new text drafted by you</strong> (the review had no replacement wording for these):
          <ul style={{ margin: '6px 0 0 16px', padding: 0 }}>{pv.needs_manual_drafting.map((i: any) => <li key={i.id}><RiskBadge r={i.risk} /> {i.title}</li>)}</ul>
          <div style={{ marginTop: 6 }}><Link to={`/matters/${m.id}/draft`}>Draft the missing provisions →</Link></div></div>}</div>}
    </div>
  )
}

function Redlines({ m }: { m: Matter }) {
  const { data, reload } = useQuery(() => api<any[]>(`/api/matters/${m.id}/redlines`), [m.id], 4000)
  if (!data) return <Loading />
  if (data.length === 0) return <div className="card"><Empty>No redlines yet. Contract reviews create them for issues that have a suggested replacement.</Empty></div>
  const set = async (id: string, status: string) => { await api(`/api/redlines/${id}`, { method: 'PATCH', json: { status } }); reload() }
  return (
    <div className="stack">{m.my_role !== 'viewer' && <RevisePanel m={m} redlines={data} />}{data.map(r => (
      <div key={r.id} className="card stack" style={{ gap: 8 }}>
        <div className="row between wrap"><div className="row" style={{ gap: 6 }}><strong>{r.clause_label || 'Clause'}</strong><RiskBadge r={r.risk} />
          <span className={`badge ${r.status === 'accepted' ? 'ok' : r.status === 'rejected' ? 'bad' : ''}`}>{r.status}</span></div>
          {m.my_role !== 'viewer' && r.proposed && <div className="row"><button className="btn sm" onClick={() => set(r.id, 'accepted')}>Accept</button><button className="btn sm" onClick={() => set(r.id, 'rejected')}>Reject</button></div>}</div>
        {r.ops ? <DiffView ops={r.ops} /> : <div className="row small muted"><span className="spin" /> Generating proposed text…</div>}
        {r.reason && <div className="small muted">Why: {r.reason}</div>}
        {r.support?.checks?.unverified_specifics?.length > 0 && <div className="err">Contains specifics not in the original or your instructions: {r.support.checks.unverified_specifics.join(', ')}</div>}
        {r.support?.needs_attorney_review?.length > 0 && <div className="small muted">Needs attorney review: {r.support.needs_attorney_review.join('; ')}</div>}
      </div>))}</div>
  )
}

function Compare({ m }: { m: Matter }) {
  const docs = useQuery(() => api<Doc[]>(`/api/matters/${m.id}/documents`), [m.id])
  const [docId, setDocId] = useState('')
  const did = docId || docs.data?.[0]?.id
  const vers = useQuery(() => did ? api<Version[]>(`/api/documents/${did}/versions`) : Promise.resolve([] as Version[]), [did])
  const [a, setA] = useState(''); const [b, setB] = useState('')
  const [sum, setSum] = useState(true)
  const [cmpId, setCmpId] = useState<string>()
  const [err, setErr] = useState<string>()
  const res = useQuery(() => cmpId ? api<any>(`/api/comparisons/${cmpId}`) : Promise.resolve(undefined), [cmpId], 4000)
  const vs = vers.data ?? []
  async function run(e: FormEvent) {
    e.preventDefault(); setErr(undefined)
    try { const r = await api<any>('/api/comparisons', { json: { version_a: a || vs[0]?.id, version_b: b || vs[vs.length - 1]?.id, summarize: sum } }); setCmpId(r.id) }
    catch (e) { setErr((e as Error).message) }
  }
  const r = res.data
  return (
    <div className="stack">
      <form className="card stack" onSubmit={run}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <label>Document<select value={did ?? ''} onChange={e => { setDocId(e.target.value); setA(''); setB('') }}>{(docs.data ?? []).map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
          <label>From version<select value={a || vs[0]?.id || ''} onChange={e => setA(e.target.value)}>{vs.map(v => <option key={v.id} value={v.id}>v{v.version_number} · {v.filename}</option>)}</select></label>
          <label>To version<select value={b || vs[vs.length - 1]?.id || ''} onChange={e => setB(e.target.value)}>{vs.map(v => <option key={v.id} value={v.id}>v{v.version_number} · {v.filename}</option>)}</select></label>
        </div>
        <label className="inline"><input type="checkbox" checked={sum} onChange={e => setSum(e.target.checked)} />Also write a plain-language summary (uses your GPU)</label>
        <Err msg={err} /><div><button className="btn primary" disabled={vs.length < 2}>Compare</button>{vs.length < 2 && <span className="muted small"> Upload a second version first.</span>}</div>
      </form>
      {r && <div className="stack">
        <div className="row wrap" style={{ gap: 6 }}>{Object.entries(r.counts as Record<string, number>).map(([k, n]) => <span key={k} className={`badge ${k === 'added' ? 'ok' : k === 'removed' ? 'bad' : k === 'modified' ? 'warn' : ''}`}>{n} {k}</span>)}</div>
        {r.summary ? <div className="card"><h3>Summary <span className="badge">AI-written; the changes below are exact</span></h3><div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{r.summary}</div></div>
          : r.summary_job_state && !['COMPLETE', 'FAILED', 'CANCELED'].includes(r.summary_job_state) ? <div className="card small row"><span className="spin" /> Writing summary…</div> : null}
        {r.result?.changes.map((c: any, i: number) => (
          <div key={i} className="card stack" style={{ gap: 6 }}>
            <div className="row wrap" style={{ gap: 6 }}><span className={`badge ${c.type === 'added' ? 'ok' : c.type === 'removed' ? 'bad' : 'warn'}`}>{c.type}</span><strong>{c.label || 'Clause'}</strong>{c.topics.slice(0, 3).map((t: string) => <span key={t} className="badge">{cap(t)}</span>)}</div>
            {c.type === 'modified' ? <DiffView ops={c.ops} /> : <div style={{ whiteSpace: 'pre-wrap' }}>{(c.a ?? c.b).text}</div>}
            {c.figure_changes && Object.entries(c.figure_changes as Record<string, any>).map(([k, v]) => <div key={k} className="small" style={{ color: 'var(--warn)' }}>⚠ {cap(k)} changed: {v.removed.join(', ') || '—'} → {v.added.join(', ') || '—'}</div>)}
          </div>))}
      </div>}
    </div>
  )
}

export default function Contracts({ m }: { m: Matter }) {
  const [tab, setTab] = useState<'reviews' | 'redlines' | 'compare'>('reviews')
  return (
    <div className="stack">
      <div className="seg" style={{ justifySelf: 'start' }}>{(['reviews', 'redlines', 'compare'] as const).map(t => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{cap(t)}</button>)}</div>
      {tab === 'reviews' ? <Reviews m={m} /> : tab === 'redlines' ? <Redlines m={m} /> : <Compare m={m} />}
    </div>
  )
}
