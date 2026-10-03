import { Link } from 'react-router-dom'
import { api, fmtTime, useQuery, type Job } from '../api'
import { Empty, JobBadge, Loading } from '../ui'

const LABEL: Record<string, string> = { llm_complete: 'Model request', ingest_document: 'Document ingest' }

export function JobTable({ jobs, showMatter }: { jobs: Job[]; showMatter?: boolean }) {
  if (!jobs.length) return <Empty>No jobs.</Empty>
  return (
    <table><thead><tr><th>Job</th><th>Status</th><th>Model / provider</th><th>Attempts</th><th>Created</th></tr></thead>
      <tbody>{jobs.map(j => (
        <tr key={j.id}>
          <td>{LABEL[j.job_type] ?? j.job_type}{showMatter && j.matter_id && <div className="small"><Link to={`/matters/${j.matter_id}`}>matter →</Link></div>}</td>
          <td><JobBadge j={j} /><div className="muted small">{j.state === 'FAILED' ? j.error : j.status_message}</div></td>
          <td className="muted small">{j.model_used ?? '—'}{j.provider_used && ` · ${j.provider_used}`}</td>
          <td>{j.attempts}</td><td className="muted small">{fmtTime(j.created_at)}</td></tr>))}</tbody></table>
  )
}

export default function JobsPage() {
  const { data } = useQuery(() => api<Job[]>('/api/jobs?limit=100'), [], 4000)
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div><h1>Jobs</h1><p className="muted">Work queued for your private GPU and background processing. Jobs wait here if the GPU is offline; nothing is sent elsewhere.</p></div>
      <div className="card flush">{data ? <JobTable jobs={data} showMatter /> : <Loading />}</div>
    </div>
  )
}
