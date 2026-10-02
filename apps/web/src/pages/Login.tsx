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
  if (!data) return <Loading />
  const setup = !data.initialized

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setErr(undefined)
    try {
      const r = await api<{ user: User; csrf_token: string }>(setup ? '/api/auth/bootstrap' : '/api/auth/login',
        { json: setup ? { email, password, display_name: name } : { email, password } })
      onAuthed(r.user, r.csrf_token)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <div className="row"><div className="brand" style={{ padding: 0 }}><Logo />Legal AI</div></div>
        <div>
          <h2>{setup ? 'Create your account' : 'Sign in'}</h2>
          <p className="muted small" style={{ marginTop: 4 }}>
            {setup ? 'First-time setup. This account becomes the administrator.' : 'Private legal research and document review.'}
          </p>
        </div>
        {setup && <label>Name<input value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></label>}
        <label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="username" autoFocus /></label>
        <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={setup ? 12 : 1}
          autoComplete={setup ? 'new-password' : 'current-password'} />
          {setup && <span className="muted small" style={{ fontWeight: 400 }}>At least 12 characters.</span>}</label>
        <Err msg={err} />
        <button className="btn primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}</button>
      </form>
    </div>
  )
}
