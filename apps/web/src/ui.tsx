import type { ReactNode } from 'react'
import { PRIVACY_LABEL, PRIVACY_HELP, type Job, type Matter } from './api'

const I = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
)
export const icons = {
  home: I('M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10'),
  folder: I('M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z'),
  jobs: I('M4 6h16M4 12h16M4 18h10'),
  gear: I('M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z'),
  lock: I('M6 11h12v9H6zM8 11V8a4 4 0 118 0v3'),
}

export const Logo = () => (
  <svg viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="var(--accent)" /><path d="M16 6v18M9 24h14M8 11h16M8 11l-3 7a3 3 0 006 0zM24 11l-3 7a3 3 0 006 0z" stroke="var(--accent-ink)" strokeWidth="1.8" fill="none" strokeLinecap="round" /></svg>
)

export const Err = ({ msg }: { msg?: string }) => (msg ? <div className="err" role="alert">{msg}</div> : null)
export const Loading = () => <div className="empty"><span className="spin" /></div>
export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>

export function PrivacyBadge({ mode }: { mode: Matter['privacy_mode'] }) {
  const cls = mode === 'local_only' ? 'ok' : mode === 'private' ? 'accent' : ''
  return <span className={`badge ${cls}`} title={PRIVACY_HELP[mode]}>{mode === 'local_only' && <span style={{ width: 12, display: 'inline-flex' }}>{icons.lock}</span>}{PRIVACY_LABEL[mode]}</span>
}

const STATE_CLS: Record<string, string> = { COMPLETE: 'ok', FAILED: 'bad', CANCELED: '', WAITING_FOR_GPU: 'warn', RUNNING: 'accent', VALIDATING: 'accent', RETRYABLE: 'warn', QUEUED: '', NEW: '' }
export const JobBadge = ({ j }: { j: Job }) => (
  <span className={`badge ${STATE_CLS[j.state] ?? ''}`}>{j.state === 'WAITING_FOR_GPU' ? 'Waiting for GPU' : j.state.replace('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase())}</span>
)

export const Disclaimer = () => (
  <p className="disclaimer">
    AI-assisted work product for legal research and review. It can be wrong. Check citations and sources, and have
    high-stakes decisions reviewed by a qualified attorney. This system is not a law firm or a licensed attorney.
  </p>
)

/** Minimal, safe markdown: **bold**, `code`, and bullet lines. Everything else is plain text (no HTML injection). */
export function Md({ text }: { text: string }) {
  const inline = (t: string) => t.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) =>
    p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong>
      : p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={i} className="mono">{p.slice(1, -1)}</code> : p)
  return <>{text.split('\n').map((line, i) => /^\s*[-*] /.test(line)
    ? <div key={i} style={{ paddingLeft: 16, textIndent: -12 }}>• {inline(line.replace(/^\s*[-*] /, ''))}</div>
    : <div key={i} style={line.trim() ? undefined : { height: 8 }}>{inline(line)}</div>)}</>
}
