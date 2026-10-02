import { Fragment, useRef, useState, type FormEvent } from 'react'
import { Link, NavLink, Route, Routes, useParams } from 'react-router-dom'
import { api, fmtBytes, fmtTime, PRIVACY_HELP, useQuery, type AuditEv, type Doc, type Job, type Matter, type Version } from '../api'
import { Empty, Err, JobBadge, Loading, Md, PrivacyBadge, icons } from '../ui'
import { JobTable } from './JobsPage'
import { PrivacyPicker } from './Matters'

export default function MatterPage() {
  const { id } = useParams()
  const { data: m, error, reload } = useQuery(() => api<Matter>(`/api/matters/${id}`), [id])
  if (error) return <div className="stack"><Err msg={error} /><Link to="/matters">← Back to matters</Link></div>
  if (!m) return <Loading />
  const base = `/matters/${m.id}`
  const tab = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '')
  return (
    <div>
      <Link to="/matters" className="small">← Matters</Link>
      <div className="row between wrap" style={{ marginTop: 6 }}>
        <div><h1>{m.name}</h1>
          <div className="muted small" style={{ marginTop: 4 }}>{m.jurisdiction || 'No jurisdiction'}{m.relevant_date && ` · relevant date ${m.relevant_date}`} · <span className="badge">{m.status}</span></div></div>
        <PrivacyBadge mode={m.privacy_mode} />
      </div>
      <div className={`privacy-banner ${m.privacy_mode}`}>
        <span style={{ width: 18, display: 'inline-flex' }}>{icons.lock}</span>
        <span><strong>{m.privacy_mode === 'local_only' ? 'Local-only matter. ' : m.privacy_mode === 'private' ? 'Private matter. ' : 'Standard matter. '}</strong>{PRIVACY_HELP[m.privacy_mode]}</span>
      </div>
      <nav className="tabs">
        <NavLink to={base} end className={tab}>Overview</NavLink>
        <NavLink to={`${base}/documents`} className={tab}>Documents</NavLink>
        <NavLink to={`${base}/research`} className={tab}>Ask the model</NavLink>
        <NavLink to={`${base}/jobs`} className={tab}>Jobs</NavLink>
        <NavLink to={`${base}/audit`} className={tab}>Audit</NavLink>
      </nav>
      <Routes>
        <Route index element={<Overview m={m} onChange={reload} />} />
        <Route path="documents" element={<Documents m={m} />} />
        <Route path="research" element={<Research m={m} />} />
        <Route path="jobs" element={<MatterJobs m={m} />} />
        <Route path="audit" element={<Audit m={m} />} />
      </Routes>
    </div>
  )
}

function Overview({ m, onChange }: { m: Matter; onChange: () => void }) {
  const owner = m.my_role === 'owner'
  const [mode, setMode] = useState(m.privacy_mode)
  const [fb, setFb] = useState(m.llm_fallback_mode)
  const [emb, setEmb] = useState(m.external_embedding_enabled)
  const [err, setErr] = useState<string>()
  const [saved, setSaved] = useState(false)
  const lo = mode === 'local_only'

  async function save(e: FormEvent) {
    e.preventDefault(); setErr(undefined); setSaved(false)
    try {
      const r = await api<Matter>(`/api/matters/${m.id}`, { method: 'PATCH', json: { privacy_mode: mode, llm_fallback_mode: lo ? 'disabled' : fb, external_embedding_enabled: lo ? false : emb } })
      setFb(r.llm_fallback_mode); setEmb(r.external_embedding_enabled); setSaved(true); onChange()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="stack">
      <div className="card"><h3>Details</h3>
        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Description</dt><dd>{m.description || <span className="muted">—</span>}</dd>
          <dt>Jurisdiction</dt><dd>{m.jurisdiction || <span className="muted">—</span>}</dd>
          <dt>Relevant date</dt><dd>{m.relevant_date || <span className="muted">—</span>}</dd>
          <dt>Your role</dt><dd>{m.my_role}</dd><dt>Created</dt><dd>{fmtTime(m.created_at)}</dd>
        </dl></div>
      <form className="card stack" onSubmit={save}>
        <h3>Privacy and external services</h3>
        <label>Privacy mode<PrivacyPicker value={mode} onChange={v => { if (owner) setMode(v) }} /></label>
        <label className="inline"><input type="checkbox" disabled={!owner || lo || mode === 'standard'} checked={mode === 'standard' ? true : emb && !lo} onChange={e => setEmb(e.target.checked)} />
          Allow external embeddings (text chunks are sent to the embedding provider)</label>
        <label>External LLM fallback when the private GPU is offline
          <select disabled={!owner || lo} value={lo ? 'disabled' : fb} onChange={e => setFb(e.target.value as Matter['llm_fallback_mode'])}>
            <option value="disabled">Disabled — jobs wait for my GPU</option>
            <option value="ask">Ask me each time</option>
            <option value="allowed">Allowed for this matter</option>
          </select>
          <span className="muted small" style={{ fontWeight: 400 }}>Fallback also requires a configured provider and a monthly budget above $0 on the server.</span></label>
        <Err msg={err} />
        {owner ? <div className="row"><button className="btn primary">Save</button>{saved && <span className="badge ok">Saved</span>}</div> : <span className="muted small">Only the matter owner can change these.</span>}
      </form>
    </div>
  )
}

function Documents({ m }: { m: Matter }) {
  const { data, reload } = useQuery(() => api<Doc[]>(`/api/matters/${m.id}/documents`), [m.id], 6000)
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [open, setOpen] = useState<string>()
  const input = useRef<HTMLInputElement>(null)
  const versionFor = useRef<string | undefined>(undefined)
  const canEdit = m.my_role !== 'viewer'

  async function upload(files: FileList | File[], documentId?: string) {
    setErr(undefined); setBusy(true)
    for (const file of Array.from(files)) {
      const form = new FormData()
      form.append('matter_id', m.id); form.append('file', file)
      if (documentId) form.append('document_id', documentId)
      try { await api('/api/documents', { form }) } catch (e) { setErr(`${file.name}: ${(e as Error).message}`) }
    }
    setBusy(false); reload()
  }
  return (
    <div className="stack">
      {canEdit && (
        <div className={`drop ${over ? 'over' : ''}`} role="button" tabIndex={0}
          onClick={() => { versionFor.current = undefined; input.current?.click() }}
          onKeyDown={e => { if (e.key === 'Enter') input.current?.click() }}
          onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
          onDrop={e => { e.preventDefault(); setOver(false); upload(e.dataTransfer.files) }}>
          {busy ? <span className="spin" /> : <><strong>Drop files here</strong> or click to browse<div className="small">PDF, DOCX, TXT, MD, HTML, EML, PNG/JPG/TIFF · up to 50 MB</div></>}
        </div>)}
      <input ref={input} type="file" multiple hidden onChange={e => { if (e.target.files?.length) upload(e.target.files, versionFor.current); e.target.value = '' }} />
      <Err msg={err} />
      {!data ? <Loading /> : data.length === 0 ? <div className="card"><Empty>No documents yet.</Empty></div> :
        <div className="card flush"><table>
          <thead><tr><th>Document</th><th>Version</th><th>Size</th><th>Integrity</th><th /></tr></thead>
          <tbody>{data.map(d => {
            const v = d.current_version
            return (<Fragment key={d.id}>
              <tr>
                <td><strong>{d.title}</strong><div className="muted small mono" title="SHA-256">{v?.sha256.slice(0, 16)}…</div></td>
                <td>v{v?.version_number}</td><td>{v && fmtBytes(v.size_bytes)}</td>
                <td>{v && <span className={`badge ${v.status === 'verified' ? 'ok' : v.status === 'rejected' ? 'bad' : 'warn'}`}>{v.status === 'verified' ? 'SHA-256 verified' : v.status}</span>}</td>
                <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                  {canEdit && <button className="btn sm" onClick={() => { versionFor.current = d.id; input.current?.click() }}>New version</button>}
                  <button className="btn sm" onClick={() => setOpen(open === d.id ? undefined : d.id)}>History</button>
                  {v && <a className="btn sm" href={`/api/documents/${d.id}/versions/${v.id}/download`}>Download</a>}</div></td>
              </tr>
              {open === d.id && <tr><td colSpan={5} style={{ background: 'var(--soft)' }}><Versions docId={d.id} /></td></tr>}
            </Fragment>)
          })}</tbody></table></div>}
    </div>
  )
}

function Versions({ docId }: { docId: string }) {
  const { data } = useQuery(() => api<Version[]>(`/api/documents/${docId}/versions`), [docId])
  if (!data) return <span className="spin" />
  return <div className="stack" style={{ gap: 6 }}>{data.map(v => (
    <div key={v.id} className="row between small wrap"><span><strong>v{v.version_number}</strong> · {v.filename} · {fmtBytes(v.size_bytes)} · {fmtTime(v.created_at)}</span>
      <span className="row"><span className="mono muted">{v.sha256.slice(0, 20)}…</span><a href={`/api/documents/${docId}/versions/${v.id}/download`}>Download</a></span></div>))}</div>
}

function Research({ m }: { m: Matter }) {
  const { data, reload } = useQuery(() => api<Job[]>(`/api/jobs?matter_id=${m.id}&limit=50`).then(js => js.filter(j => j.job_type === 'llm_complete').reverse()), [m.id], 3000)
  const [text, setText] = useState('')
  const [role, setRole] = useState<'auto' | 'fast' | 'deep'>('auto')
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  const canEdit = m.my_role !== 'viewer'

  async function send(e: FormEvent) {
    e.preventDefault(); if (!text.trim()) return
    setBusy(true); setErr(undefined)
    try {
      await api('/api/inference', { json: { matter_id: m.id, role, messages: [{ role: 'user', content: text }] } })
      setText(''); reload()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const act = async (j: Job, what: 'cancel' | 'approve-fallback') => { await api(`/api/jobs/${j.id}/${what}`, { method: 'POST' }); reload() }

  return (
    <div className="stack">
      <div className="card" style={{ background: 'var(--warn-soft)', borderColor: 'transparent' }}>
        <strong>Direct model access, no sources yet.</strong>{' '}
        <span className="small">Requests run on your private GPU through the job queue. Source-grounded research with verified citations arrives with the retrieval phase, so don't rely on legal citations from this screen.</span>
      </div>
      {!data ? <Loading /> : data.length === 0 ? <div className="card"><Empty>Nothing asked yet.</Empty></div> :
        <div className="stack" style={{ gap: 18 }}>{data.map(j => (
          <div key={j.id} className="msg">
            <div className="bubble q">{j.request?.messages?.at(-1)?.content}</div>
            {j.state === 'COMPLETE' && <div className="bubble a"><Md text={j.result?.content ?? ''} /><div className="muted small" style={{ marginTop: 8 }}>{j.model_used} · {j.provider_used}</div></div>}
            {j.state !== 'COMPLETE' && (
              <div className="row wrap small"><JobBadge j={j} />
                {(j.state === 'FAILED' ? j.error : j.status_message) && !/^(running|queued|validating)$/i.test(j.status_message) && <span className="muted">{j.state === 'FAILED' ? j.error : j.status_message}</span>}
                {!['FAILED', 'CANCELED'].includes(j.state) && <button className="btn sm danger" onClick={() => act(j, 'cancel')}>Cancel</button>}
                {j.needs_fallback_approval && m.my_role === 'owner' && <button className="btn sm" onClick={() => act(j, 'approve-fallback')}>Approve external fallback for this request</button>}
              </div>)}
          </div>))}</div>}
      {canEdit && (
        <form className="card stack" onSubmit={send}>
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Ask a question or paste text to analyze…" onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e) }} />
          <div className="row between wrap"><div className="row"><span className="muted small">Model</span>
            <div className="seg">{(['auto', 'fast', 'deep'] as const).map(r => <button type="button" key={r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>{r[0].toUpperCase() + r.slice(1)}</button>)}</div></div>
            <button className="btn primary" disabled={busy || !text.trim()}>Send</button></div>
          <Err msg={err} />
        </form>)}
    </div>
  )
}

function MatterJobs({ m }: { m: Matter }) {
  const { data } = useQuery(() => api<Job[]>(`/api/jobs?matter_id=${m.id}&limit=100`), [m.id], 4000)
  return data ? <div className="card flush"><JobTable jobs={data} /></div> : <Loading />
}

function Audit({ m }: { m: Matter }) {
  const { data, error } = useQuery(() => api<AuditEv[]>(`/api/matters/${m.id}/audit?limit=200`), [m.id])
  if (error) return <Err msg={error} />
  if (!data) return <Loading />
  return <div className="card flush"><table><thead><tr><th>When</th><th>Action</th><th>Object</th><th>Detail</th></tr></thead>
    <tbody>{data.map(e => (<tr key={e.id}><td className="muted small" style={{ whiteSpace: 'nowrap' }}>{fmtTime(e.at)}</td><td><span className="mono">{e.action}</span></td>
      <td className="muted small">{e.object_type}</td><td className="muted small mono" style={{ wordBreak: 'break-all' }}>{Object.keys(e.detail).length ? JSON.stringify(e.detail) : ''}</td></tr>))}</tbody></table></div>
}
