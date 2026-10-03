import { useCallback, useEffect, useRef, useState } from 'react'

export type User = { id: string; email: string; display_name: string; role: string; mfa_enabled?: boolean }
export type Matter = {
  id: string; name: string; description: string; jurisdiction: string; relevant_date: string | null
  status: string; privacy_mode: 'standard' | 'private' | 'local_only'; external_embedding_enabled: boolean
  llm_fallback_mode: 'disabled' | 'ask' | 'allowed'; my_role: string; created_at: string
  embedding_route: 'external' | 'local'; embedding_model: string
}
export type Version = { id: string; version_number: number; filename: string; content_type: string; size_bytes: number; sha256: string; status: string; created_at: string
  parse_status: string; parse_error: string | null; page_count: number | null; ocr_applied?: boolean; ocr_confidence?: number | null; embed_status: string; embedding_model: string | null }
export type Authority = {
  authority_type: string; jurisdiction: string; court: string; court_level: string; citation: string
  document_date: string | null; effective_from: string | null; effective_to: string | null; precedential_status: string
  source_url: string; official_source: boolean; superseded: boolean; metadata_source: 'detected' | 'user'
}
export const AUTHORITY_TYPES = ['user_document', 'constitution', 'statute', 'regulation', 'administrative_guidance', 'court_opinion', 'court_rule', 'agency_material', 'official_form', 'treatise', 'template']
export type Doc = { id: string; matter_id: string; title: string; doc_type: string; authority: Authority; current_version: Version | null; job_id?: string }
export type Job = {
  id: string; job_type: string; state: string; status_message: string; matter_id: string | null; attempts: number
  needs_fallback_approval: boolean; provider_used: string | null; model_used: string | null
  result: { content?: string } | null; request: { messages: { role: string; content: string }[]; role: string } | null
  error: string | null; created_at: string; finished_at: string | null
}
export type Gpu = { online: boolean; node_id: string; gpu: string | null; vram_free_mb: number | null; models: string[]; last_heartbeat_at: string | null; queue: Record<string, number>; waiting: number }
export type AuditEv = { id: string; at: string; user_id: string | null; action: string; object_type: string; object_id: string; detail: Record<string, unknown> }
export type Providers = { primary: string; fallback: string; external_llm_monthly_budget_usd: number; embedding_provider: string; embedding_model: string; models: Record<string, string> }

let csrf = ''
/** When this UI is served inside the FounderOS shell it lives under /legal-ui; standalone it lives at the root. */
export const ROOT = typeof location !== 'undefined' && location.pathname.startsWith('/legal-ui') ? '/legal-ui' : ''

export const setCsrf = (t: string) => { csrf = t }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

export async function api<T = unknown>(path: string, opts: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const method = opts.method ?? (opts.json || opts.form ? 'POST' : 'GET')
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json) }
  if (opts.form) body = opts.form
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf
  const r = await fetch(ROOT + path, { method, headers, body, credentials: 'same-origin' })
  if (!r.ok) {
    let msg = r.statusText
    try {
      const d = await r.json()
      msg = typeof d.detail === 'string' ? d.detail : Array.isArray(d.detail) ? d.detail.map((x: { msg: string }) => x.msg).join('; ') : msg
    } catch { /* non-JSON error body */ }
    throw new ApiError(r.status, msg)
  }
  return r.json() as Promise<T>
}

/** POST JSON and download the binary response as a file (used for generated documents). */
export async function downloadPost(path: string, json: unknown): Promise<{ filename: string; applied: string | null }> {
  const r = await fetch(ROOT + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(json), credentials: 'same-origin' })
  if (!r.ok) {
    let msg = r.statusText
    try { const d = await r.json(); msg = typeof d.detail === 'string' ? d.detail : msg } catch { /* not JSON */ }
    throw new ApiError(r.status, msg)
  }
  const m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')
  const filename = m?.[1] ?? 'document'
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement('a')
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return { filename, applied: r.headers.get('x-revise-applied') }
}

/** GET a binary response and download it as a file. Returns the filename. */
export async function downloadBlob(path: string): Promise<string> {
  const r = await fetch(ROOT + path, { credentials: 'same-origin' })
  if (!r.ok) {
    let msg = r.statusText
    try { const d = await r.json(); msg = typeof d.detail === 'string' ? d.detail : msg } catch { /* not JSON */ }
    throw new ApiError(r.status, msg)
  }
  const m = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')
  const filename = m?.[1] ?? 'document'
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement('a')
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return filename
}

/** Fetch on mount and every `ms` (if given); returns data, error, and a manual reload. */
export function useQuery<T>(fn: () => Promise<T>, deps: unknown[], ms?: number) {
  const [data, setData] = useState<T | undefined>()
  const [error, setError] = useState<string>()
  const fnRef = useRef(fn)
  fnRef.current = fn
  const load = useCallback(async () => {
    try { setData(await fnRef.current()); setError(undefined) } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => {
    setData(undefined)
    load()
    if (!ms) return
    const t = setInterval(load, ms)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ms])
  return { data, error, reload: load }
}

export const fmtBytes = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
export const fmtTime = (s: string) => new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
export const PRIVACY_LABEL = { standard: 'Standard', private: 'Private', local_only: 'Local-only' } as const
export const PRIVACY_HELP = {
  standard: 'External embeddings allowed. External LLM fallback only if you enable it for this matter.',
  private: 'External embeddings only if you switch them on. External LLM fallback off by default.',
  local_only: 'Maximum privacy. Nothing leaves Railway and your own GPU: no external embeddings, no external LLM.',
} as const
