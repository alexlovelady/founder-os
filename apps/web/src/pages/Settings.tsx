import { Fragment } from 'react'
import { api, fmtTime, useQuery, type Gpu, type Providers } from '../api'
import { Loading } from '../ui'
import { useAuth } from '../App'

/* eslint-disable @typescript-eslint/no-explicit-any */
function AdminPanel() {
  const health = useQuery(() => api<any>('/api/admin/health'), [], 15000)
  const metrics = useQuery(() => api<any>('/api/admin/metrics'), [], 30000)
  const users = useQuery(() => api<any[]>('/api/admin/users'), [])
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`
  return (
    <>
      <div className="card"><h3>System health</h3>
        {!health.data ? <Loading /> : <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
          {Object.entries(health.data.checks as Record<string, any>).map(([k, c]) => (
            <span key={k} className={`badge ${c.ok ? 'ok' : c.optional ? 'warn' : 'bad'}`} title={JSON.stringify(c)}>{k}: {c.ok ? 'ok' : c.optional ? 'offline' : 'problem'}</span>))}
          {health.data.checks.queue?.oldest_waiting_minutes > 0 && <span className="muted small">Oldest waiting job: {health.data.checks.queue.oldest_waiting_minutes} min</span>}</div>}</div>
      <div className="card"><h3>Usage and budgets</h3>
        {!metrics.data ? <Loading /> : <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Matters / documents</dt><dd>{metrics.data.counts.matters} / {metrics.data.counts.documents} ({metrics.data.counts.chunks} passages)</dd>
          <dt>Document storage</dt><dd>{mb(metrics.data.storage_bytes)}</dd><dt>Database size</dt><dd>{mb(metrics.data.database_bytes)}</dd>
          <dt>Jobs</dt><dd>{Object.entries(metrics.data.jobs as Record<string, number>).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(' · ') || '—'}</dd>
          <dt>External LLM budget</dt><dd>${metrics.data.budgets.external_llm.spent_usd} of ${metrics.data.budgets.external_llm.limit_usd} this month</dd>
          <dt>Embedding budget</dt><dd>${metrics.data.budgets.embedding.spent_usd} of {metrics.data.budgets.embedding.limit_usd ?? 'no limit'} this month</dd>
          {metrics.data.usage_month_to_date.map((u: any, i: number) => <Fragment key={i}><dt>{u.provider} ({u.kind}{u.external ? ', external' : ''})</dt><dd>{u.calls} calls · {u.tokens.toLocaleString()} tokens · ${u.cost_usd}</dd></Fragment>)}</dl>}</div>
      <div className="card"><h3>Users</h3>
        {!users.data ? <Loading /> : <table style={{ marginTop: 8 }}><tbody>{users.data.map((u: any) => (
          <tr key={u.id}><td>{u.email}<div className="muted small">{u.role}</div></td><td><span className={`badge ${u.is_active ? 'ok' : 'bad'}`}>{u.is_active ? 'active' : 'deactivated'}</span></td>
            <td><button className="btn sm" onClick={async () => { try { await api(`/api/admin/users/${u.id}`, { method: 'PATCH', json: { is_active: !u.is_active } }); users.reload() } catch (e) { alert((e as Error).message) } }}>{u.is_active ? 'Deactivate' : 'Reactivate'}</button></td></tr>))}</tbody></table>}</div>
    </>
  )
}

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
      {user.role === 'admin' && <AdminPanel />}
    </div>
  )
}
