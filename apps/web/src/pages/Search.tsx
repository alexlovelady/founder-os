import { useState, type FormEvent } from 'react'
import { api, useQuery, type Matter } from '../api'
import { Empty, Err, Loading } from '../ui'

export type Hit = {
  cite_id: string; chunk_id: string; document_id: string; document_title: string; version_number: number
  page: number | null; page_end: number | null; heading_path: string[]; section_number: string
  text: string; score: number; semantic_rank: number | null; lexical_rank: number | null
  authority_type?: string; jurisdiction?: string; flags?: string[]
}
type SearchResp = { hits: Hit[]; warnings: string[]; embedding_model: string; mode: string }
type ChunkCtx = Hit & { char_start: number; char_end: number; before: string; after: string; is_current_version: boolean }

export const where = (h: Pick<Hit, 'page' | 'page_end' | 'heading_path' | 'section_number'>) =>
  [h.page ? (h.page_end && h.page_end !== h.page ? `pp. ${h.page}–${h.page_end}` : `p. ${h.page}`) : null,
   h.heading_path.length ? h.heading_path.join(' › ') : null].filter(Boolean).join(' · ')

export function SourceViewer({ chunkId, onClose }: { chunkId: string; onClose: () => void }) {
  const { data, error } = useQuery(() => api<ChunkCtx>(`/api/chunks/${chunkId}?context=900`), [chunkId])
  return (
    <div role="dialog" aria-label="Source passage" onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', padding: 20, zIndex: 20 }}>
      <div className="card" onClick={e => e.stopPropagation()} style={{ maxWidth: 760, width: '100%', maxHeight: '86vh', overflow: 'auto' }}>
        <div className="row between"><h3>Source passage</h3><button className="btn sm" onClick={onClose}>Close</button></div>
        <Err msg={error} />
        {!data ? !error && <Loading /> : <div className="stack" style={{ marginTop: 10 }}>
          <div className="small muted">{data.document_title} · v{data.version_number}{!data.is_current_version && ' (superseded version)'}
            <br />{where(data) || 'No page or heading information'} · characters {data.char_start}–{data.char_end}</div>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            <span className="muted">{data.before}</span>
            <mark style={{ background: 'var(--warn-soft)', color: 'inherit', padding: '1px 2px', borderRadius: 3 }}>{data.text}</mark>
            <span className="muted">{data.after}</span></div>
        </div>}
      </div>
    </div>
  )
}

export default function Search({ m }: { m: Matter }) {
  const [q, setQ] = useState('')
  const [mode, setMode] = useState<'hybrid' | 'semantic' | 'lexical'>('hybrid')
  const [res, setRes] = useState<SearchResp>()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()
  const [open, setOpen] = useState<string>()

  async function run(e: FormEvent) {
    e.preventDefault(); if (!q.trim()) return
    setBusy(true); setErr(undefined)
    try { setRes(await api<SearchResp>(`/api/matters/${m.id}/search`, { json: { query: q, mode, k: 10 } })) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="stack">
      <form className="card stack" onSubmit={run}>
        <div className="row"><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search this matter's documents…" aria-label="Search query" autoFocus />
          <button className="btn primary" disabled={busy || !q.trim()}>{busy ? <span className="spin" /> : 'Search'}</button></div>
        <div className="row between wrap"><div className="seg">{(['hybrid', 'semantic', 'lexical'] as const).map(x =>
          <button type="button" key={x} className={mode === x ? 'on' : ''} onClick={() => setMode(x)}>{x[0].toUpperCase() + x.slice(1)}</button>)}</div>
          <span className="muted small">Embeddings: {m.embedding_route === 'external' ? 'external API (Voyage)' : 'private GPU (local)'}</span></div>
      </form>
      <Err msg={err} />
      {res?.warnings.map(w => <div key={w} className="card" style={{ background: 'var(--warn-soft)', borderColor: 'transparent' }}>{w}</div>)}
      {res && (res.hits.length === 0 ? <div className="card"><Empty>No matching passages. Documents may still be processing — check the Documents tab.</Empty></div> :
        <div className="stack" style={{ gap: 10 }}>{res.hits.map(h => (
          <button key={h.chunk_id} className="card" onClick={() => setOpen(h.chunk_id)}
            style={{ textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' }} aria-label={`Open ${h.cite_id}`}>
            <div className="row between wrap"><div className="row"><span className="badge accent mono">{h.cite_id}</span><strong>{h.document_title}</strong>
              <span className="muted small">v{h.version_number}</span></div>
              <div className="row wrap" style={{ gap: 4 }}>{h.flags?.map(f => <span key={f} className="badge warn">{f.replace(/_/g, ' ')}</span>)}{h.semantic_rank && <span className="badge">semantic #{h.semantic_rank}</span>}{h.lexical_rank && <span className="badge">keyword #{h.lexical_rank}</span>}</div></div>
            <div className="muted small" style={{ margin: '4px 0 8px' }}>{where(h) || 'No location info'}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{h.text.length > 420 ? h.text.slice(0, 420) + '…' : h.text}</div>
          </button>))}</div>)}
      {open && <SourceViewer chunkId={open} onClose={() => setOpen(undefined)} />}
    </div>
  )
}
