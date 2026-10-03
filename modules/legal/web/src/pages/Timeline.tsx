import { useState } from 'react'
import { api, useQuery, type Matter } from '../api'
import { Empty, Loading } from '../ui'
import { SourceViewer } from './Search'

type Ob = {
  id: string; party: string; obligation: string; trigger: string; deadline_text: string; deadline_date: string | null
  recurrence: string; source_chunk_id: string | null; source_clause: string; confidence: string; status: string
}

export default function Timeline({ m }: { m: Matter }) {
  const { data, reload } = useQuery(() => api<Ob[]>(`/api/matters/${m.id}/obligations`), [m.id], 8000)
  const [show, setShow] = useState<'open' | 'all'>('open')
  const [chunk, setChunk] = useState<string>()
  if (!data) return <Loading />
  const rows = data.filter(o => show === 'all' || o.status === 'open')
  const set = async (o: Ob, status: string) => { await api(`/api/obligations/${o.id}`, { method: 'PATCH', json: { status } }); reload() }
  const today = new Date().toISOString().slice(0, 10)
  return (
    <div className="stack">
      <div className="row between wrap"><span className="muted small">Extracted from contract reviews. Confidence is the model's own; check each against the clause. Nothing here creates reminders or calendar events.</span>
        <div className="seg">{(['open', 'all'] as const).map(s => <button key={s} className={show === s ? 'on' : ''} onClick={() => setShow(s)}>{s === 'open' ? 'Open' : 'All'}</button>)}</div></div>
      {rows.length === 0 ? <div className="card"><Empty>No obligations yet. Run a contract review to extract them.</Empty></div> :
        <div className="card flush"><table><thead><tr><th>Party</th><th>Obligation</th><th>Trigger</th><th>Deadline</th><th>Source</th><th /></tr></thead>
          <tbody>{rows.map(o => (
            <tr key={o.id} style={o.status !== 'open' ? { opacity: .55 } : undefined}>
              <td>{o.party || '—'}</td>
              <td>{o.obligation}{o.recurrence && <div className="muted small">Recurs: {o.recurrence}</div>}<span className={`badge ${o.confidence === 'high' ? 'ok' : o.confidence === 'low' ? 'warn' : ''}`} style={{ marginTop: 4 }}>{o.confidence} confidence</span></td>
              <td className="small">{o.trigger || '—'}</td>
              <td className="small">{o.deadline_date ? <><strong style={o.deadline_date < today && o.status === 'open' ? { color: 'var(--bad)' } : undefined}>{o.deadline_date}</strong><div className="muted">{o.deadline_text}</div></> : o.deadline_text || '—'}</td>
              <td className="small">{o.source_chunk_id ? <button className="btn sm" onClick={() => setChunk(o.source_chunk_id!)}>{o.source_clause || 'View'}</button> : '—'}</td>
              <td><div className="row" style={{ justifyContent: 'flex-end' }}>{m.my_role !== 'viewer' && (o.status === 'open'
                ? <><button className="btn sm" onClick={() => set(o, 'done')}>Done</button><button className="btn sm" onClick={() => set(o, 'dismissed')}>Dismiss</button></>
                : <button className="btn sm" onClick={() => set(o, 'open')}>Reopen</button>)}</div></td>
            </tr>))}</tbody></table></div>}
      {chunk && <SourceViewer chunkId={chunk} onClose={() => setChunk(undefined)} />}
    </div>
  )
}
