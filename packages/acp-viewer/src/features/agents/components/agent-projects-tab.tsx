import { EmptyState, Pill } from '@/components/primitives'
import { Boxes } from 'lucide-react'
import { Link } from 'react-router-dom'
import { formatDateTime } from '../agent-utils'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

const GRID = '14px minmax(220px,1.4fr) 140px 110px minmax(160px,1fr)'

export function AgentProjectsTab({ detail }: Props) {
  if (detail.memberships.length === 0) {
    return <EmptyState icon={<Boxes className="h-8 w-8" />} title="No memberships" />
  }

  return (
    <section className="max-w-5xl">
      <div
        style={{ gridTemplateColumns: GRID }}
        className="grid items-center gap-x-6 pb-2 border-b border-border/60"
      >
        {[null, 'Project', 'Role', 'Default', 'Created'].map((label, i) => (
          <span key={label ?? `_${i}`} className="kicker text-muted truncate">
            {label ?? ''}
          </span>
        ))}
      </div>

      <ul>
        {detail.memberships.map((m) => (
          <li
            key={m.projectId}
            style={{ gridTemplateColumns: GRID }}
            className="grid items-center gap-x-6 py-3 border-b border-border/40"
          >
            <span className="block h-1.5 w-1.5 rounded-full bg-accent" />
            <Link to={`/projects/${encodeURIComponent(m.projectId)}`} className="min-w-0 group">
              <div className="text-[13px] text-ink truncate group-hover:text-accent">
                {m.project?.displayName ?? m.projectId}
              </div>
              <div className="mono text-[10px] text-muted truncate">{m.projectId}</div>
            </Link>
            <span className="mono text-[11px] text-ink">{m.role}</span>
            {m.isDefaultAgent ? (
              <Pill tone="accent">default</Pill>
            ) : (
              <span className="text-quiet text-[11px]">—</span>
            )}
            <span className="mono text-[11px] tabular text-muted">
              {formatDateTime(m.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
