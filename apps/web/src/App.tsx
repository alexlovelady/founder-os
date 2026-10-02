import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { api, setCsrf, useQuery, type Gpu, type User } from './api'
import { Disclaimer, Loading, Logo, icons } from './ui'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Matters from './pages/Matters'
import MatterPage from './pages/MatterPage'
import JobsPage from './pages/JobsPage'
import Settings from './pages/Settings'
import Authorities from './pages/Authorities'

type Auth = { user: User; logout: () => Promise<void> }
const AuthCtx = createContext<Auth>(null as unknown as Auth)
export const useAuth = () => useContext(AuthCtx)

function GpuIndicator() {
  const { data } = useQuery(() => api<Gpu>('/api/gpu/status'), [], 10000)
  if (!data) return <div className="gpu small muted">Checking GPU…</div>
  const queued = (data.queue.QUEUED ?? 0) + (data.queue.RUNNING ?? 0) + (data.queue.RETRYABLE ?? 0)
  return (
    <div className="gpu small" title={data.last_heartbeat_at ? `Last heartbeat ${new Date(data.last_heartbeat_at).toLocaleTimeString()}` : 'No heartbeat yet'}>
      <div className="row"><span className={`dot ${data.online ? 'on' : 'off'}`} /><strong>Private GPU: {data.online ? 'Online' : 'Offline'}</strong></div>
      {data.online
        ? <div className="muted">{data.gpu}{data.vram_free_mb != null && ` · ${(data.vram_free_mb / 1024).toFixed(1)} GB free`}<br />Queue: {queued}</div>
        : <div className="muted">{data.waiting} job{data.waiting === 1 ? '' : 's'} waiting</div>}
    </div>
  )
}

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth()
  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><Logo />Legal AI</div>
        <nav className="nav">
          <NavLink to="/" end>{icons.home}Dashboard</NavLink>
          <NavLink to="/matters">{icons.folder}Matters</NavLink>
          <NavLink to="/authorities">{icons.folder}Authorities</NavLink>
          <NavLink to="/jobs">{icons.jobs}Jobs</NavLink>
          <NavLink to="/settings">{icons.gear}Settings</NavLink>
        </nav>
        <div className="side-foot">
          <GpuIndicator />
          <div className="small muted" style={{ padding: '0 4px' }}>
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.email}</div>
            <a href="#" onClick={e => { e.preventDefault(); logout() }}>Sign out</a>
          </div>
        </div>
      </aside>
      <main>{children}<Disclaimer /></main>
    </div>
  )
}

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined)
  useEffect(() => {
    api<{ user: User; csrf_token: string }>('/api/auth/me')
      .then(r => { setCsrf(r.csrf_token); setUser(r.user) })
      .catch(() => setUser(null))
  }, [])
  if (user === undefined) return <Loading />
  if (!user) return <Login onAuthed={(u, t) => { setCsrf(t); setUser(u) }} />
  const logout = async () => { await api('/api/auth/logout', { method: 'POST' }); setCsrf(''); setUser(null) }
  return (
    <AuthCtx.Provider value={{ user, logout }}>
      <Shell>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/matters" element={<Matters />} />
          <Route path="/matters/:id/*" element={<MatterPage />} />
          <Route path="/authorities" element={<Authorities />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </Shell>
    </AuthCtx.Provider>
  )
}
