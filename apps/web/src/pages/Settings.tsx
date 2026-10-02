import { Fragment } from 'react'
import { api, fmtTime, useQuery, type Gpu, type Providers } from '../api'
import { Loading } from '../ui'
import { useAuth } from '../App'

export default function Settings() {
  const { user } = useAuth()
  const p = useQuery(() => api<Providers>('/api/providers/status'), [])
  const g = useQuery(() => api<Gpu>('/api/gpu/status'), [], 10000)
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div><h1>Settings</h1><p className="muted">Read-only view of the server configuration. Change these in Railway variables.</p></div>
      <div className="card"><h3>Account</h3>
        <dl className="kv" style={{ marginTop: 10 }}><dt>Email</dt><dd>{user.email}</dd><dt>Role</dt><dd>{user.role}</dd></dl></div>
      <div className="card"><h3>Private GPU node</h3>
        {!g.data ? <Loading /> : <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Status</dt><dd><span className={`badge ${g.data.online ? 'ok' : 'bad'}`}>{g.data.online ? 'Online' : 'Offline'}</span></dd>
          <dt>Node</dt><dd>{g.data.node_id}</dd><dt>GPU</dt><dd>{g.data.gpu ?? '—'}</dd>
          <dt>Free VRAM</dt><dd>{g.data.vram_free_mb != null ? `${(g.data.vram_free_mb / 1024).toFixed(1)} GB` : '—'}</dd>
          <dt>Models</dt><dd>{g.data.models.join(', ') || '—'}</dd>
          <dt>Last heartbeat</dt><dd>{g.data.last_heartbeat_at ? fmtTime(g.data.last_heartbeat_at) : 'never'}</dd></dl>}</div>
      <div className="card"><h3>Providers and budgets</h3>
        {!p.data ? <Loading /> : <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Primary LLM</dt><dd>{p.data.primary}</dd>
          <dt>External fallback</dt><dd>{p.data.fallback === 'disabled' ? <span className="badge ok">Disabled</span> : p.data.fallback}</dd>
          <dt>External LLM budget</dt><dd>${p.data.external_llm_monthly_budget_usd.toFixed(2)} / month</dd>
          <dt>Embeddings</dt><dd>{p.data.embedding_provider} · {p.data.embedding_model}</dd>
          {Object.entries(p.data.models).map(([k, v]) => <Fragment key={k}><dt>{k[0].toUpperCase() + k.slice(1)} model</dt><dd className="mono">{v}</dd></Fragment>)}</dl>}</div>
    </div>
  )
}
