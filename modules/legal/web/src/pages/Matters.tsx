import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, fmtTime, PRIVACY_HELP, PRIVACY_LABEL, useQuery, type Matter } from '../api'
import { Empty, Err, Loading, PrivacyBadge } from '../ui'

export function PrivacyPicker({ value, onChange }: { value: Matter['privacy_mode']; onChange: (m: Matter['privacy_mode']) => void }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="seg" role="radiogroup" aria-label="Privacy mode">
        {(['standard', 'private', 'local_only'] as const).map(m => (
          <button type="button" key={m} role="radio" aria-checked={value === m} className={value === m ? 'on' : ''} onClick={() => onChange(m)}>{PRIVACY_LABEL[m]}</button>))}
      </div>
      <span className="muted small" style={{ fontWeight: 400 }}>{PRIVACY_HELP[value]}</span>
    </div>
  )
}

export default function Matters() {
  const { data, reload } = useQuery(() => api<Matter[]>('/api/matters'), [])
  const [show, setShow] = useState(false)
  const nav = useNavigate()
  const [f, setF] = useState({ name: '', description: '', jurisdiction: '', relevant_date: '', privacy_mode: 'private' as Matter['privacy_mode'] })
  const [err, setErr] = useState<string>()

  async function create(e: FormEvent) {
    e.preventDefault(); setErr(undefined)
    try {
      const m = await api<Matter>('/api/matters', { json: { ...f, relevant_date: f.relevant_date || null } })
      reload(); nav(`/matters/${m.id}`)
    } catch (e) { setErr((e as Error).message) }
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="row between"><div><h1>Projects</h1><p className="muted">Each project keeps its own documents, conversations and audit trail.</p></div>
        <button className="btn primary" onClick={() => setShow(s => !s)}>{show ? 'Cancel' : 'New project'}</button></div>
      {show && (
        <form className="card stack" onSubmit={create}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <label>Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required autoFocus /></label>
            <label>Jurisdiction<input value={f.jurisdiction} placeholder="e.g. Delaware, US-FED" onChange={e => setF({ ...f, jurisdiction: e.target.value })} /></label>
            <label>Relevant date<input type="date" value={f.relevant_date} onChange={e => setF({ ...f, relevant_date: e.target.value })} /></label>
          </div>
          <label>Description<textarea value={f.description} onChange={e => setF({ ...f, description: e.target.value })} style={{ minHeight: 64 }} /></label>
          <label>Privacy mode<PrivacyPicker value={f.privacy_mode} onChange={privacy_mode => setF({ ...f, privacy_mode })} /></label>
          <Err msg={err} />
          <div><button className="btn primary">Create project</button></div>
        </form>)}
      {!data ? <Loading /> : data.length === 0 ? <div className="card"><Empty>No projects yet.</Empty></div> :
        <div className="card flush"><table>
          <thead><tr><th>Project</th><th>Jurisdiction</th><th>Privacy</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>{data.map(m => (
            <tr key={m.id}><td><Link to={`/matters/${m.id}`}><strong>{m.name}</strong></Link></td><td>{m.jurisdiction || '—'}</td>
              <td><PrivacyBadge mode={m.privacy_mode} /></td><td><span className="badge">{m.status}</span></td><td className="muted small">{fmtTime(m.created_at)}</td></tr>))}</tbody>
        </table></div>}
    </div>
  )
}
