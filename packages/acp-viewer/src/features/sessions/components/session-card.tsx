import { AgentAvatar } from '@/features/agents/components/agent-avatar'
import type { SessionTimelineRow } from '@/features/sessions/types'
import { cn } from '@/lib/cn'
import { ArrowUpRight, GitBranch } from 'lucide-react'
import { Link } from 'react-router-dom'
import {
  FAMILY_ACCENT,
  compactRef,
  durationLabel,
  parseScopeRef,
  rowSelected,
} from './event-family'

export function SessionCard({
  row,
  selectedRowId,
  onSelectRow,
}: {
  row: SessionTimelineRow
  selectedRowId?: string | undefined
  onSelectRow: (rowId: string) => void
}) {
  const scope = parseScopeRef(row.sessionRef.scopeRef)
  const agentId = scope.agentId ?? 'unknown'
  const workLabel = scope.taskId ?? scope.role ?? 'primary'
  const selected = rowSelected(row, selectedRowId)
  const status = row.runtime?.status ?? 'unknown'
  const familyColor =
    FAMILY_ACCENT[
      row.visualState.colorRole === 'message' ? 'agent_message' : row.visualState.colorRole
    ]

  return (
    <article
      className={cn(
        'group relative rounded-[6px] border bg-card/50 transition-colors',
        selected ? 'border-accent bg-selected/70' : 'border-border hover:border-border-strong'
      )}
    >
      <button
        type="button"
        onClick={() => onSelectRow(row.rowId)}
        className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 p-3 text-left"
      >
        <AgentAvatar agentId={agentId} size="sm" forceMonogram={agentId === 'unknown'} />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className={cn('h-2 w-2 rounded-full', familyColor)} aria-hidden="true" />
            <strong className="text-[14px] font-semibold text-ink">{agentId}</strong>
            <span className="mono text-[10px] uppercase text-muted">{status}</span>
          </span>
          <span
            className="mt-1 block truncate text-[12px] text-muted"
            title={row.sessionRef.scopeRef}
          >
            {scope.projectId ?? compactRef(row.sessionRef.scopeRef, 34)}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-quiet">
            <span className="inline-flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              {row.sessionRef.laneRef}
            </span>
            <span>{workLabel}</span>
            <span className="mono tabular">{durationLabel(row.stats.lastEventAt)}</span>
          </span>
        </span>
        <span className="text-right">
          <span className="mono block text-[18px] leading-none tabular text-ink">
            {row.stats.eventsPerMinute.toFixed(1)}
          </span>
          <span className="kicker text-[8px] text-muted">events/min</span>
        </span>
      </button>

      {scope.agentId && (
        <Link
          to={`/agents/${encodeURIComponent(scope.agentId)}`}
          aria-label={`Open ${scope.agentId} agent detail`}
          className="absolute bottom-2 right-2 inline-flex h-7 w-7 items-center justify-center rounded-[4px] text-quiet opacity-0 transition hover:bg-secondary hover:text-accent group-hover:opacity-100 focus:opacity-100"
        >
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </article>
  )
}
