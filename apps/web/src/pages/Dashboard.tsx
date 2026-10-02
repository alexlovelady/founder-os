import { Link } from 'react-router-dom'
import { api, fmtTime, useQuery, type Gpu, type Job, type Matter } from '../api'
import { Empty, JobBadge, Loading, PrivacyBadge } from '../ui'
import { useAuth } from '../App'

export default function Dashboard() {
  const { user } = useAuth()
  const matters = useQuery(() => api<Matter[]>('/api/matters'), [])
  const jobs = useQuery(() => api<Job[]>('/api/jobs?limit=8'), [], 8000)
  const gpu = useQuery(() => api<Gpu>('/api/gpu/status'), [], 10000)
  const open = matters.data?.filter(m => m.status === 'open') ?? []
  const waiting = jobs.data?.filter(j => j.state === 'WAITING_FOR_GPU').length ?? 0
  return (
    <div className="stack" style={{ gap: 22 }}>
      <div><h1>Welcome{user.display_name ? `, ${user.display_name.split(' ')[0]}` : ''}</h1><p className="muted">Your matters, documents and private inference queue.</p></div>
      <div className="grid">
        <div className="card"><div className="muted small">Open matters</div><div className="stat">{matters.data ? open.length : '–'}</div></div>
        <div className="card"><div className="muted small">Private GPU</div>
          <div className="stat" style={{ fontSize: 22, paddingTop: 6 }}>{gpu.data ? (gpu.data.online ? 'Online' : 'Offline') : '–'}</div>
          <div className="muted small">{gpu.data?.online ? gpu.data.models.join(', ') || 'no models listed' : 'Jobs queue until it returns'}</div></div>
        <div className="card"><div className="muted small">Jobs waiting for GPU</div><div className="stat">{jobs.data ? waiting : '–'}</div></div>
      </div>
      <section className="stack">
        <div className="row between"><h2>Recent matters</h2><Link to="/matters" className="small">All matters →</Link></div>
        {!matters.data ? <Loading /> : matters.data.length === 0
          ? <div className="card"><Empty>No matters yet. <Link to="/matters">Create your first matter</Link> to start uploading documents.</Empty></div>
          : <div className="grid">{matters.data.slice(0, 6).map(m => (
            <Link key={m.id} to={`/matters/${m.id}`} className="card" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="row between"><h3>{m.name}</h3><PrivacyBadge mode={m.privacy_mode} /></div>
              <p className="muted small" style={{ margin: '6px 0 0' }}>{m.jurisdiction || 'No jurisdiction set'} · {fmtTime(m.created_at)}</p>
            </Link>))}</div>}
      </section>
      <section className="stack">
        <div className="row between"><h2>Recent jobs</h2><Link to="/jobs" className="small">All jobs →</Link></div>
        <div className="card flush">
          {!jobs.data ? <Loading /> : jobs.data.length === 0 ? <Empty>No jobs yet.</Empty> :
            <table><tbody>{jobs.data.map(j => (
              <tr key={j.id}><td>{j.job_type === 'llm_complete' ? 'Model request' : 'Document ingest'}</td><td><JobBadge j={j} /></td><td className="muted small">{fmtTime(j.created_at)}</td></tr>))}</tbody></table>}
        </div>
      </section>
    </div>
  )
}
