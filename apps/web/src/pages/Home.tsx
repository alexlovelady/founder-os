/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, fmtTime, useQuery, type Job } from '../api'
import { useCompany } from '../friendly'
import { useAuth } from '../App'
import { Err, Loading } from '../ui'

type Catalog = { entity_types: { id: string; label: string }[]; states: string[] }

function Onboarding({ onDone }: { onDone: () => void }) {
  const cat = useQuery(() => api<Catalog>('/api/startup/catalog'), [])
  const [f, setF] = useState({ company_name: '', entity_type: 'delaware_c_corp', state: 'Delaware', stage: '' })
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  async function go(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(undefined)
    try { await api('/api/onboarding', { json: f }); onDone() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  if (!cat.data) return <Loading />
  return (
    <form className="card stack" onSubmit={go} style={{ maxWidth: 640 }}>
      <div><h2>Tell us about your company</h2><p className="muted">Takes 30 seconds. It lets us pick the right checklist, set the governing law, and keep your documents in one place.</p></div>
      <label>Company name<input value={f.company_name} onChange={e => setF({ ...f, company_name: e.target.value })} required autoFocus placeholder="Acme Labs, Inc." /></label>
      <label>Type of company
        <select value={f.entity_type} onChange={e => setF({ ...f, entity_type: e.target.value })}>{cat.data.entity_types.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
        <span className="tip">Not sure? Most venture-backed startups are Delaware C-corps; many small businesses are LLCs.</span></label>
      <label>State where it is (or will be) formed<select value={f.state} onChange={e => setF({ ...f, state: e.target.value })}>{cat.data.states.map(s => <option key={s}>{s}</option>)}</select></label>
      <Err msg={err} />
      <div><button className="btn primary" disabled={busy}>Set up my workspace</button></div>
    </form>
  )
}

function Checklist({ matterId }: { matterId: string }) {
  const nav = useNavigate()
  const { data, reload } = useQuery(() => api<any>(`/api/matters/${matterId}/checklist`), [matterId], 15000)
  const [open, setOpen] = useState(true)
  if (!data) return <Loading />
  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0
  const mark = async (id: string, status: string) => { await api(`/api/matters/${matterId}/checklist/${id}`, { method: 'PUT', json: { status } }); reload() }
  return (
    <div className="card stack">
      <div className="row between wrap"><div><h2>Your legal checklist</h2><p className="muted small" style={{ margin: 0 }}>The documents most startups need. We spot the ones you have by reading what you upload.</p></div>
        <div style={{ minWidth: 200 }}><div className="small" style={{ textAlign: 'right' }}><strong>{data.done}</strong> of {data.total} done</div><div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${pct}%` }} /></div></div></div>
      <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => setOpen(!open)}>{open ? 'Hide list' : 'Show list'}</button>
      {open && <div>{data.items.map((i: any) => (
        <div key={i.id} className={`check ${i.status}`}>
          <div className="box">{i.status === 'done' ? '✓' : ''}</div>
          <div><div style={{ fontWeight: 600 }}>{i.title}{i.optional && <span className="badge" style={{ marginLeft: 8 }}>if you have raised money</span>}</div>
            <div className="muted small">{i.status === 'done' && i.detected ? `Found: ${i.documents.map((d: any) => d.title).join(', ')}` : i.why}</div></div>
          <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
            {i.status === 'todo' && i.draft && <button className="btn sm primary" onClick={() => nav(`/create?type=${i.draft}`)}>Create it</button>}
            {i.status === 'todo' && !i.manual && <button className="btn sm" onClick={() => nav(`/review`)}>I have one: review it</button>}
            {i.status === 'todo' && <button className="btn sm" onClick={() => mark(i.id, 'done')}>{i.manual ? 'Mark done' : 'Done elsewhere'}</button>}
            {i.status === 'todo' && <button className="btn sm" onClick={() => mark(i.id, 'not_needed')}>Not needed</button>}
            {(i.status === 'not_needed' || (i.status === 'done' && !i.detected)) && <button className="btn sm" onClick={() => mark(i.id, 'todo')}>Undo</button>}</div>
        </div>))}</div>}
    </div>
  )
}

export default function Home() {
  const { user } = useAuth()
  const { company, reload } = useCompany()
  const jobs = useQuery(() => api<Job[]>('/api/jobs?limit=12'), [], 8000)
  const waiting = jobs.data?.filter(j => j.state === 'WAITING_FOR_GPU').length ?? 0
  const first = user.display_name ? user.display_name.split(' ')[0] : ''
  const [tourDone, setTourDone] = useState(() => { try { return localStorage.getItem('tour') === '1' } catch { return false } })
  const dismissTour = () => { try { localStorage.setItem('tour', '1') } catch { /* private mode */ } setTourDone(true) }
  if (company === undefined) return <Loading />
  const p = (company as any)?.profile
  return (
    <div className="stack" style={{ gap: 24 }}>
      <div className="hero"><h1>{p?.company_name ? `${p.company_name}` : `Welcome${first ? `, ${first}` : ''}`}</h1>
        <p className="muted">{company ? 'What do you want to do today?' : 'Your private legal assistant for contracts, company documents and legal questions.'}</p></div>
      {!company ? <Onboarding onDone={reload} /> : <>
        {!tourDone && <div className="callout row between wrap"><span><strong>New here?</strong> A five-minute guide shows how each part works.</span><span className="row"><Link className="btn sm primary" to="/help" onClick={dismissTour}>Show me how</Link><button className="btn sm" onClick={dismissTour}>Dismiss</button></span></div>}
        <div className="actions">
          <Link className="action" to="/review"><div className="ico">📄</div><strong>Review a contract</strong><span className="sub">Upload something you were sent. Get a plain-English summary, the risks, and fixes you can send back.</span></Link>
          <Link className="action" to="/create"><div className="ico">✍️</div><strong>Create a document</strong><span className="sub">Founders agreement, NDA, contractor agreement, offer letter, privacy policy and more.</span></Link>
          <Link className="action" to="/ask"><div className="ico">💬</div><strong>Ask a legal question</strong><span className="sub">Answers come from your documents and the law library, with the source for every claim.</span></Link>
        </div>
        {waiting > 0 && <div className="callout warn"><strong>Your private AI computer is offline.</strong> {waiting} request{waiting === 1 ? ' is' : 's are'} saved and will run automatically when it is back on. Nothing is sent to outside AI services.</div>}
        <Checklist matterId={company.id} />
        <div className="card flush"><div style={{ padding: '14px 18px' }}><h3>Recent activity</h3></div>
          {!jobs.data ? <Loading /> : jobs.data.length === 0 ? <div className="empty">Nothing yet. Pick one of the three options above.</div> :
            <table><tbody>{jobs.data.slice(0, 6).map(j => (
              <tr key={j.id}><td>{({ contract_review: 'Contract review', draft: 'Document draft', research: 'Legal question', ingest_document: 'Reading a document', llm_complete: 'AI request', redline_generation: 'Suggested change', embed_document: 'Indexing a document' } as any)[j.job_type] ?? 'Task'}</td>
                <td className="small muted">{j.state === 'COMPLETE' ? 'Done' : j.state === 'WAITING_FOR_GPU' ? 'Waiting for your AI computer' : j.state === 'FAILED' ? 'Did not work' : 'Working'}</td><td className="muted small">{fmtTime(j.created_at)}</td></tr>))}</tbody></table>}
        </div>
      </>}
    </div>
  )
}
