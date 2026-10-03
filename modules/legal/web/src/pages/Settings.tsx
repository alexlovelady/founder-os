import { Fragment, useState, type FormEvent } from 'react'
import { api, fmtTime, useQuery, type Gpu, type Providers } from '../api'
import { Err, Loading } from '../ui'
import { useAuth } from '../App'

/* eslint-disable @typescript-eslint/no-explicit-any */
function SecurityCard() {
  const { user } = useAuth()
  const status = useQuery(() => api<{ enabled: boolean; recovery_codes_left: number }>('/api/auth/mfa/status'), [])
  const [setup, setSetup] = useState<{ secret: string; qr_svg: string } | null>(null)
  const [code, setCode] = useState('')
  const [pw, setPw] = useState('')
  const [codes, setCodes] = useState<string[]>()
  const [err, setErr] = useState<string>()
  const [note, setNote] = useState<string>()
  const wrap = async (fn: () => Promise<void>) => { setErr(undefined); try { await fn() } catch (e) { setErr((e as Error).message) } }
  const start = () => wrap(async () => { setSetup(await api('/api/auth/mfa/setup', { method: 'POST' })); setCode('') })
  const enable = (e: FormEvent) => { e.preventDefault(); return wrap(async () => { const r = await api<{ recovery_codes: string[] }>('/api/auth/mfa/enable', { json: { code } }); setCodes(r.recovery_codes); setSetup(null); status.reload() }) }
  const disable = (e: FormEvent) => { e.preventDefault(); return wrap(async () => { await api('/api/auth/mfa/disable', { json: { password: pw, code } }); setPw(''); setCode(''); status.reload(); setNote('Two-step verification turned off.') }) }
  return (
    <div className="card stack">
      <h3>Security</h3>
      <div className="row between wrap"><div><strong>Two-step verification</strong><div className="muted small">Time-based codes from an authenticator app (Google Authenticator, 1Password, Authy…).</div></div>
        <span className={`badge ${status.data?.enabled ? 'ok' : 'warn'}`}>{status.data?.enabled ? `On · ${status.data.recovery_codes_left} recovery codes left` : 'Off'}</span></div>
      {codes && <div className="card" style={{ background: 'var(--warn-soft)', borderColor: 'transparent' }}><strong>Save these recovery codes now.</strong> Each works once if you lose your phone. They are shown only this time.
        <div className="mono" style={{ columns: 2, marginTop: 8 }}>{codes.map(c => <div key={c}>{c}</div>)}</div><button className="btn sm" style={{ marginTop: 8 }} onClick={() => setCodes(undefined)}>I saved them</button></div>}
      {!status.data?.enabled && !setup && <div><button className="btn primary" onClick={start}>Set up two-step verification</button></div>}
      {setup && <form className="stack" onSubmit={enable}>
        <div className="row wrap" style={{ alignItems: 'flex-start' }}><div style={{ width: 170, background: '#fff', padding: 6, borderRadius: 8 }} dangerouslySetInnerHTML={{ __html: setup.qr_svg }} />
          <div className="stack" style={{ gap: 6, flex: 1, minWidth: 220 }}><span className="small">Scan the code with your authenticator app, or enter this key manually:</span><code className="mono" style={{ wordBreak: 'break-all' }}>{setup.secret}</code>
            <label>Enter the 6-digit code to confirm<input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" required /></label></div></div>
        <div className="row"><button className="btn primary">Turn on</button><button type="button" className="btn" onClick={() => setSetup(null)}>Cancel</button></div></form>}
      {status.data?.enabled && !codes && <form className="stack" onSubmit={disable}>
        <span className="muted small">To turn it off, confirm your password and a current code (or a recovery code).</span>
        <div className="row wrap"><input type="password" placeholder="Password" style={{ flex: 1, minWidth: 160 }} value={pw} onChange={e => setPw(e.target.value)} required autoComplete="current-password" />
          <input placeholder="Code" style={{ width: 150 }} value={code} onChange={e => setCode(e.target.value)} required /><button className="btn danger">Turn off</button></div></form>}
      <div className="row between wrap"><span className="small muted">Signed in as {user.email}</span>
        <button className="btn sm" onClick={async () => { const r = await api<{ revoked: number }>('/api/auth/sessions/revoke-others', { method: 'POST' }); setNote(`Signed out ${r.revoked} other session(s).`) }}>Sign out everywhere else</button></div>
      {note && <span className="badge ok">{note}</span>}<Err msg={err} />
    </div>
  )
}

function BackupsPanel() {
  const { data, reload } = useQuery(() => api<any>('/api/admin/backup'), [], 20000)
  const [msg, setMsg] = useState<string>()
  return (
    <div className="card stack"><h3>Backups</h3>
      {!data ? <Loading /> : <>
        <div className="muted small">{data.enabled ? 'Scheduled backups are on. Each is restored into a scratch database and every document is checked against its hash.' : 'Scheduled backups are off. Set BACKUP_ENABLED=true on the server.'}</div>
        {data.backups.length === 0 ? <span className="muted small">No backups yet.</span> : <table><tbody>{data.backups.slice(0, 6).map((b: any) => (
          <tr key={b.name}><td className="mono small">{b.name}</td><td className="small">{(b.db_dump_bytes / 1048576).toFixed(1)} MB · {b.row_counts.documents} documents</td>
            <td>{b.verified_at ? (b.verify_problems.length ? <span className="badge bad">verification failed</span> : <span className="badge ok">restore verified</span>) : <span className="badge warn">not verified</span>}</td></tr>))}</tbody></table>}
        <div className="row"><button className="btn sm" onClick={async () => { await api('/api/admin/backup', { method: 'POST' }); setMsg('Backup queued.'); setTimeout(reload, 4000) }}>Back up now</button>{msg && <span className="badge ok">{msg}</span>}</div>
        <span className="muted small">For an off-site copy, run scripts/pull_backup.py on your own computer (see docs/backup.md).</span></>}
    </div>
  )
}

function AdminPanel() {
  const health = useQuery(() => api<any>('/api/admin/health'), [], 15000)
  const metrics = useQuery(() => api<any>('/api/admin/metrics'), [], 30000)
  const users = useQuery(() => api<any[]>('/api/admin/users'), [])
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`
  return (
    <>
      <BackupsPanel />
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
      <SecurityCard />
      {user.role === 'admin' && <AdminPanel />}
    </div>
  )
}
