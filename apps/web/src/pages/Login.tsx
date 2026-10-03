import { useState, type FormEvent } from 'react'
import { api, useQuery, type User } from '../api'
import { Err, Loading, Logo } from '../ui'

export default function Login({ onAuthed }: { onAuthed: (u: User, csrf: string) => void }) {
  const { data } = useQuery(() => api<{ initialized: boolean }>('/api/auth/status'), [])
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [mfaToken, setMfaToken] = useState<string>()
  const [code, setCode] = useState('')
  if (!data) return <Loading />
  const setup = !data.initialized

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(undefined)
    try {
      if (mfaToken) {
        const r = await api<{ user: User; csrf_token: string }>('/api/auth/login/mfa', { json: { mfa_token: mfaToken, code } })
        onAuthed(r.user, r.csrf_token)
        return
      }
      const r = await api<{ user: User; csrf_token: string; mfa_required?: boolean; mfa_token?: string }>(setup ? '/api/auth/bootstrap' : '/api/auth/login',
        { json: setup ? { email, password, display_name: name } : { email, password } })
      if (r.mfa_required && r.mfa_token) { setMfaToken(r.mfa_token); setPassword(''); return }
      onAuthed(r.user, r.csrf_token)
    } catch (e) {
      setErr((e as Error).message)
      if (mfaToken && /Start again/.test((e as Error).message)) { setMfaToken(undefined); setCode('') }
    } finally { setBusy(false) }
  }

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <div className="row"><div className="brand" style={{ padding: 0 }}><Logo />Legal AI</div></div>
        <div>
          <h2>{setup ? 'Create your account' : mfaToken ? 'Two-step verification' : 'Sign in'}</h2>
          <p className="muted small" style={{ marginTop: 4 }}>
            {setup ? 'First-time setup. This account becomes the administrator.' : 'Private legal research and document review.'}
          </p>
        </div>
        {mfaToken ? <>
          <label>Authentication code<input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required placeholder="123456 or a recovery code" /></label>
          <span className="muted small">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</span></> : <>
        {setup && <label>Name<input value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></label>}
        <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="username" autoFocus /></label>
        <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={setup ? 12 : 1}
          autoComplete={setup ? 'new-password' : 'current-password'} />
          {setup && <span className="muted small" style={{ fontWeight: 400 }}>At least 12 characters.</span>}</label></>}
        <Err msg={err} />
        <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Please wait…' : mfaToken ? 'Verify' : setup ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>
  )
}
