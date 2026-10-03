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
  const presets = useQuery(() => api<any[]>('/api/library/presets'), [])
  const [f, setF] = useState({ name: '', adapter: 'ecfr', title: '', part: '', url: '', sections: '', opinion: '', jurisdiction: 'United States (Federal)', authority_type: 'regulation', refresh_hours: 24 })
  const [err, setErr] = useState<string>()
  async function add(e: FormEvent) {
    e.preventDefault(); setErr(undefined)
    try {
      await api('/api/library/sources', { json: { name: f.name, adapter: f.adapter, jurisdiction: f.jurisdiction, authority_type: f.authority_type, refresh_hours: Number(f.refresh_hours),
        config: f.adapter === 'ecfr' ? { title: Number(f.title), part: Number(f.part) } : f.adapter === 'uscode' ? { title: Number(f.title), sections: f.sections }
          : f.adapter === 'courtlistener' ? { opinion_id: Number(f.opinion) } : { url: f.url } } })
      setF({ ...f, name: '', title: '', part: '', url: '', sections: '', opinion: '' }); reload()
    } catch (e) { setErr((e as Error).message) }
  }
  return (
    <div className="stack">
      <h2>Sources (administrator)</h2>
      {presets.data && <div className="card stack" style={{ gap: 8 }}><h3>Starting points</h3>
        <div className="muted small">One click adds an official source and fetches it now. These are examples, not a complete or authoritative selection. Large ones take a while to embed.</div>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>{presets.data.map((p: any) => (
          <div key={p.id} className="row between" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', gap: 8 }}>
            <div><div className="small"><strong>{p.name}</strong></div><div className="muted small">{p.note}</div></div>
            <button className="btn sm" disabled={p.added} onClick={async () => { try {
              for (const it of (p.items ?? [{ name: p.name, config: p.config }])) await api('/api/library/sources', { json: { name: it.name, adapter: p.adapter, config: it.config, jurisdiction: p.jurisdiction, authority_type: p.authority_type, refresh_hours: 24 } })
              presets.reload(); reload() } catch (e) { alert((e as Error).message) } }}>{p.added ? 'Added' : 'Add'}</button></div>))}</div></div>}
      <form className="card stack" onSubmit={add}>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <label>Name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} required placeholder="e.g. FTC Safeguards Rule" /></label>
          <label>Adapter<select value={f.adapter} onChange={e => setF({ ...f, adapter: e.target.value })}><option value="ecfr">eCFR (Code of Federal Regulations)</option><option value="uscode">U.S. Code sections (govinfo)</option><option value="courtlistener">Court opinion (CourtListener, needs a token)</option><option value="url">Official https URL</option></select></label>
          {f.adapter === 'ecfr' ? <><label>CFR title<input type="number" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} required /></label>
            <label>Part<input type="number" value={f.part} onChange={e => setF({ ...f, part: e.target.value })} required /></label></>
            : f.adapter === 'uscode' ? <><label>U.S.C. title<input type="number" value={f.title} onChange={e => setF({ ...f, title: e.target.value })} required /></label>
              <label>Sections<input value={f.sections} onChange={e => setF({ ...f, sections: e.target.value })} required placeholder="e.g. 101-122, 201" /></label></>
              : f.adapter === 'courtlistener' ? <label>Opinion ID<input type="number" value={f.opinion} onChange={e => setF({ ...f, opinion: e.target.value })} required /></label>
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
      <div><h1>Legal library</h1><p className="muted">A shared library of public legal sources, fetched from official sources and kept with full version history. Every project's research can draw on it; your private documents never go into it.</p></div>
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
      {user.role === 'admin' && <><StateLaw /><LandmarkCases /><Sources /></>}
    </div>
  )
}

function StateLaw() {
  const { data, reload } = useQuery(() => api<any>('/api/library/states'), [])
  const [busy, setBusy] = useState<string>()
  const [msg, setMsg] = useState<string>()
  if (!data) return <Loading />
  const list: any[] = data.states
  if (list.length === 0) return <div className="card muted small">No state catalog is installed.</div>
  const addable = (s: any) => ['llc', 'corp'].filter(k => s.kinds[k]?.available && !s.kinds[k].added)
  const add = async (s: any) => {
    setBusy(s.code); setMsg(undefined)
    try { const r = await api<any>(`/api/library/states/${s.code}`, { json: { kinds: addable(s) } }); setMsg(`${s.name}: ${r.created} source${r.created === 1 ? '' : 's'} added.`) }
    catch (e) { setMsg((e as Error).message) } finally { setBusy(undefined); reload() }
  }
  const addAll = async () => { for (const s of list) if (addable(s).length) await add(s) }
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row between wrap"><div><h3>State law (company formation)</h3>
        <div className="muted small">LLC and corporation acts, checked against official state sources. Where an official free copy could not be fetched, it says so rather than guessing. Updated {data.generated ?? 'n/a'}.</div></div>
        <button className="btn primary" disabled={!!busy} onClick={addAll}>Add every state</button></div>
      {msg && <div className="badge ok" style={{ justifySelf: 'start' }}>{msg}</div>}
      <table><thead><tr><th>State</th><th>LLC act</th><th>Corporation act</th><th /></tr></thead><tbody>{list.map(s => (
        <tr key={s.code}><td><strong>{s.name}</strong></td>
          {(['llc', 'corp'] as const).map(k => { const x = s.kinds[k]; return (
            <td key={k} className="small">{!x || !x.available ? <span className="badge warn" title={x?.caveat}>no free official source</span>
              : <>{x.added ? <span className="badge ok">in library</span> : <span className="badge">available</span>}{x.caveat && <div className="muted" style={{ maxWidth: 260 }}>{x.caveat}</div>}</>}</td>) })}
          <td><button className="btn sm" disabled={!!busy || addable(s).length === 0} onClick={() => add(s)}>{addable(s).length > 0 ? 'Add' : (['llc', 'corp'].some(k => s.kinds[k]?.available) ? 'Added' : 'None')}</button></td></tr>))}</tbody></table>
    </div>
  )
}

function LandmarkCases() {
  const { data, reload } = useQuery(() => api<any>('/api/library/cases'), [])
  const [msg, setMsg] = useState<string>()
  if (!data) return <Loading />
  if (data.groups.length === 0) return null
  const add = async (group: string) => {
    try { const r = await api<any>('/api/library/cases', { json: { group } }); setMsg(`${r.created} case${r.created === 1 ? '' : 's'} added.`); reload() } catch (e) { setMsg((e as Error).message) }
  }
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <h3>Landmark cases</h3>
      <div className="muted small">Well-known court opinions from CourtListener. Treatment (good law or not) is never guessed; an administrator records it.{!data.token_configured && ' A CourtListener token is not configured, so these cannot be fetched yet.'}</div>
      {msg && <div className="badge ok" style={{ justifySelf: 'start' }}>{msg}</div>}
      {data.groups.map((g: any) => (
        <div key={g.name} className="row between wrap" style={{ border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}>
          <div><strong className="small">{g.name}</strong><div className="muted small">{g.cases.map((c: any) => c.name).join(' · ')}</div></div>
          <button className="btn sm" disabled={g.cases.every((c: any) => c.added) || !data.token_configured} onClick={() => add(g.name)}>{g.cases.every((c: any) => c.added) ? 'Added' : 'Add group'}</button></div>))}
    </div>
  )
}
