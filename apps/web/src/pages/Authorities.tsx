/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, type FormEvent } from 'react'
import { api, fmtTime, useQuery } from '../api'
import { Empty, Err, Loading } from '../ui'
import { useAuth } from '../App'

const TREAT = ['followed', 'affirmed', 'distinguished', 'questioned', 'criticized', 'limited', 'overruled', 'reversed', 'vacated', 'abrogated', 'superseded_by', 'repealed', 'amended']

function Treatment({ doc, onSaved }: { doc: any; onSaved: () => void }) {
  const [rows, setRows] = useState<any[]>(doc.treatment ?? [])
  const [err, setErr] = useState<string>()
  async function save() {
    setErr(undefined)
    try { await api(`/api/library/documents/${doc.id}/treatment`, { method: 'PUT', json: { treatment: rows.map(r => ({ ...r, date: r.date || null })) } }); onSaved() }
    catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="muted small">Record subsequent history from an authoritative source. The system never infers whether something is still good law. Negative treatment lowers ranking and is flagged in research.</div>
      {rows.map((r, i) => <div key={i} className="row wrap">
        <select style={{ width: 150 }} value={r.type} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, type: e.target.value } : x))}>{TREAT.map(t => <option key={t}>{t}</option>)}</select>
        <input style={{ flex: 1, minWidth: 140 }} placeholder="Citing authority" value={r.citing ?? ''} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, citing: e.target.value } : x))} />
        <input style={{ width: 150 }} type="date" value={r.date ?? ''} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, date: e.target.value } : x))} />
        <input style={{ flex: 1, minWidth: 140 }} placeholder="Source" value={r.source ?? ''} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, source: e.target.value } : x))} />
        <button className="btn sm danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button></div>)}
      <Err msg={err} />
      <div className="row"><button className="btn sm" onClick={() => setRows([...rows, { type: 'questioned', citing: '', note: '', date: '', source: '' }])}>Add entry</button><button className="btn sm primary" onClick={save}>Save treatment</button></div>
    </div>
  )
}

function Sources() {
  const { data, reload } = useQuery(() => api<any[]>('/api/library/sources'), [], 10000)
  const [f, setF] = useState({ name: '', adapter: 'ecfr', title: '', part: '', url: '', jurisdiction: 'United States (Federal)', authority_type: 'regulation', refresh_hours: 24 })
  const [err, setErr] = useState<string>()
  async function add(e: FormEvent) {
    e.preventDefault(); setErr(undefined)
    try {
      await api('/api/library/sources', { json: { name: f.name, adapter: f.adapter, jurisdiction: f.jurisdiction, authority_type: f.authority_type, refresh_hours: Number(f.refresh_hours),
        config: f.adapter === 'ecfr' ? { title: Number(f.title), part: Number(f.part) } : { url: f.url } } })
      setF({ ...f, name: '', title: '', part: '', url: '' }); reload()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="stack">
      <h2>Sources (administrator)</h2>
      <form className="card stack" onSubmit={add}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <label>Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required placeholder="e.g. FTC Safeguards Rule" /></label>
          <label>Adapter<select value={f.adapter} onChange={e => setF({ ...f, adapter: e.target.value })}><option value="ecfr">eCFR (Code of Federal Regulations)</option><option value="url">Official https URL</option></select></label>
          {f.adapter === 'ecfr' ? <><label>CFR title<input type="number" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} required /></label>
            <label>Part<input type="number" value={f.part} onChange={e => setF({ ...f, part: e.target.value })} required /></label></>
            : <label style={{ gridColumn: 'span 2' }}>URL (https, public)<input value={f.url} onChange={e => setF({ ...f, url: e.target.value })} required placeholder="https://…" /></label>}
          <label>Jurisdiction<input value={f.jurisdiction} onChange={e => setF({ ...f, jurisdiction: e.target.value })} /></label>
          <label>Type<select value={f.authority_type} onChange={e => setF({ ...f, authority_type: e.target.value })}>{['regulation', 'statute', 'court_opinion', 'court_rule', 'administrative_guidance', 'agency_material', 'official_form', 'constitution', 'treatise'].map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></label>
          <label>Refresh every (hours)<input type="number" min={1} value={f.refresh_hours} onChange={e => setF({ ...f, refresh_hours: Number(e.target.value) })} /></label>
        </div>
        <Err msg={err} /><div><button className="btn primary">Add source and fetch now</button></div>
      </form>
      {data && data.length > 0 && <div className="card flush"><table><thead><tr><th>Source</th><th>Last check</th><th>Status</th><th /></tr></thead><tbody>{data.map(s => (
        <tr key={s.id}><td><strong>{s.name}</strong><div className="muted small">{s.adapter} · {JSON.stringify(s.config)} · every {s.refresh_hours}h</div></td>
          <td className="small">{s.last_checked_at ? fmtTime(s.last_checked_at) : 'never'}</td>
          <td className="small"><span className={`badge ${s.last_status.startsWith('error') ? 'bad' : s.last_status === 'unchanged' || s.last_status.startsWith('updated') ? 'ok' : ''}`}>{s.last_status}</span></td>
          <td><div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn sm" onClick={async () => { await api(`/api/library/sources/${s.id}/refresh`, { method: 'POST' }); reload() }}>Refresh now</button>
            <button className="btn sm" onClick={async () => { await api(`/api/library/sources/${s.id}`, { method: 'PATCH', json: { enabled: !s.enabled } }); reload() }}>{s.enabled ? 'Pause' : 'Resume'}</button>
            <button className="btn sm danger" onClick={async () => { if (confirm('Delete this source? Fetched documents and their history are kept.')) { await api(`/api/library/sources/${s.id}`, { method: 'DELETE' }); reload() } }}>Delete</button></div></td></tr>))}</tbody></table></div>}
    </div>
  )
}

export default function Authorities() {
  const { user } = useAuth()
  const { data, reload } = useQuery(() => api<{ documents: any[] }>('/api/library'), [], 10000)
  const [open, setOpen] = useState<string>()
  return (
    <div className="stack" style={{ gap: 22 }}>
      <div><h1>Authorities</h1><p className="muted">A shared library of public legal sources, fetched from official sources and kept with full version history. Every matter's research can draw on it; your private documents never go into it.</p></div>
      {!data ? <Loading /> : data.documents.length === 0 ? <div className="card"><Empty>{user.role === 'admin' ? 'The library is empty. Add an official source below.' : 'The library is empty. An administrator can add official sources.'}</Empty></div> :
        <div className="stack" style={{ gap: 8 }}>{data.documents.map(d => (
          <div key={d.id} className="card">
            <div className="row between wrap"><div><strong>{d.title}</strong><div className="muted small">{d.citation} · {d.jurisdiction || 'jurisdiction not set'} · {String(d.authority_type).replace(/_/g, ' ')}</div></div>
              <div className="row wrap" style={{ gap: 6 }}>
                <span className="badge">v{d.current_version} of {d.versions}</span>{d.effective_from && <span className="badge">effective {d.effective_from}</span>}
                {d.retrieved_at && <span className="badge ok" title="Last verified from the official source">verified {fmtTime(d.retrieved_at)}</span>}
                <span className={`badge ${d.embed_status === 'embedded' ? 'ok' : 'warn'}`}>{d.parse_status !== 'parsed' ? 'processing' : d.embed_status === 'embedded' ? 'searchable' : 'embedding'}</span>
                {d.treatment.length > 0 && <span className="badge warn">{d.treatment.length} treatment entr{d.treatment.length === 1 ? 'y' : 'ies'}</span>}
                {d.source_url && <a className="small" href={d.source_url} target="_blank" rel="noreferrer noopener">official source ↗</a>}
                {user.role === 'admin' && <button className="btn sm" onClick={() => setOpen(open === d.id ? undefined : d.id)}>Treatment</button>}</div></div>
            {open === d.id && <div style={{ marginTop: 12 }}><Treatment doc={d} onSaved={() => { setOpen(undefined); reload() }} /></div>}
          </div>))}</div>}
      {user.role === 'admin' && <Sources />}
    </div>
  )
}
