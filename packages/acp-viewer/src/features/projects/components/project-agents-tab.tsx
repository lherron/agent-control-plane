import { EmptyState, Pill } from '@/components/primitives'
import { Bot } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatDateTime } from '../project-utils'
import type { ProjectDetailState } from '../types'

interface Props {
  detail: ProjectDetailState
}

const GRID = '14px minmax(220px,1.4fr) 140px 110px minmax(160px,1fr)'

export function ProjectAgentsTab({ detail }: Props) {
  if (detail.memberships.length === 0) {
    return <EmptyState icon={<Bot className="h-8 w-8" />} title="No memberships" />
  }

  return (
    <section className="max-w-5xl">
      <div
        style={{ gridTemplateColumns: GRID }}
        className="grid items-center gap-x-6 pb-2 border-b border-border/60"
      >
        {[null, 'Agent', 'Role', 'Status', 'Created'].map((label, i) => (
          <span key={label ?? `_${i}`} className="kicker text-muted truncate">
            {label ?? ''}
          </span>
        ))}
      </div>

      <ul>
        {detail.memberships.map((m) => (
          <li
            key={m.agentId}
            style={{ gridTemplateColumns: GRID }}
            className="grid items-center gap-x-6 py-3 border-b border-border/40"
          >
            <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
            <Link to={`/agents/${encodeURIComponent(m.agentId)}`} className="min-w-0 group">
              <div className="text-[13px] text-ink truncate group-hover:text-accent">
                {m.agent?.displayName ?? m.agentId}
              </div>
              <div className="mono text-[10px] text-muted truncate">{m.agentId}</div>
            </Link>
            <span className="mono text-[11px] text-ink">{m.role}</span>
            <Pill tone="muted">{m.agent?.status ?? 'unknown'}</Pill>
            <span className="mono text-[11px] tabular text-muted">
              {formatDateTime(m.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
