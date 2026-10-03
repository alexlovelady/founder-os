import { useEffect, useState } from 'react'
import { api, type Matter } from './api'

/** The company workspace (created at onboarding). `undefined` while loading, `null` if none yet. */
export function useCompany() {
  const [company, setCompany] = useState<Matter | null | undefined>(undefined)
  const reload = async () => {
    try {
      const ms = await api<Matter[]>('/api/matters')
      setCompany(ms.find(m => (m as unknown as { profile?: { company?: boolean } }).profile?.company) ?? null)
    } catch { setCompany(null) }
  }
  useEffect(() => { reload() }, [])
  return { company, reload }
}

export const PERSPECTIVES = [
  { id: 'customer', title: 'I am the one paying', blurb: 'I am the customer, or the company buying a service, hiring, or signing up.' },
  { id: 'vendor', title: 'I am providing the service', blurb: 'I am selling a product or service and want terms that protect my company.' },
  { id: 'employer', title: 'I am the employer', blurb: 'I am hiring someone and want protection for the company.' },
  { id: 'employee', title: 'I am the employee or contractor', blurb: 'I am the person being hired and want to understand what I am agreeing to.' },
  { id: 'neutral', title: 'Not sure / both sides', blurb: 'Give me a balanced read.' },
] as const

/** Plain-language progress for a background job. */
export function jobText(state: string | null | undefined, message: string | undefined, what = 'your request'): { text: string; tone: 'work' | 'wait' | 'bad' } {
  switch (state) {
    case 'WAITING_FOR_GPU': return { tone: 'wait', text: `Your private AI computer is offline right now. ${what[0].toUpperCase() + what.slice(1)} is saved and will start as soon as it is back on. Nothing is sent anywhere else.` }
    case 'QUEUED': case 'NEW': return { tone: 'work', text: 'Waiting in line…' }
    case 'RUNNING': case 'VALIDATING': return { tone: 'work', text: message && !/^running$/i.test(message) ? message : 'Working on it…' }
    case 'RETRYABLE': return { tone: 'wait', text: 'Hit a snag and trying again…' }
    case 'FAILED': return { tone: 'bad', text: 'This did not work.' }
    case 'CANCELED': return { tone: 'bad', text: 'Canceled.' }
    default: return { tone: 'work', text: 'Working on it…' }
  }
}

export const RISK_WORDS: Record<string, string> = { critical: 'Critical', high: 'High priority', medium: 'Worth a look', low: 'Minor', informational: 'FYI' }

export function overallRisk(counts: Record<string, number> | undefined): { label: string; cls: string } {
  const c = counts ?? {}
  if ((c.critical ?? 0) > 0) return { label: 'Do not sign yet', cls: 'bad' }
  if ((c.high ?? 0) > 0) return { label: 'Needs your attention', cls: 'bad' }
  if ((c.medium ?? 0) > 0) return { label: 'A few things to check', cls: 'warn' }
  return { label: 'Looks routine', cls: 'ok' }
}
