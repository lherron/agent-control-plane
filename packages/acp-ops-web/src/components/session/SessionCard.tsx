import type { SessionTimelineRow } from 'acp-ops-projection'
import { parseScopeRef } from '../../lib/sessionRefs'
import { durationLabel } from '../../lib/time'

export function SessionCard({
  row,
  selected,
  onSelect,
}: {
  row: SessionTimelineRow
  selected: boolean
  onSelect: (row: SessionTimelineRow) => void
}) {
  const scope = parseScopeRef(row.sessionRef.scopeRef)
  const workLabel = scope.role && !scope.task ? 'role' : 'task'
  const workValue = scope.task ?? scope.role ?? 'n/a'

  return (
    <button
      type="button"
      className={selected ? 'session-row selected' : 'session-row'}
      onClick={() => onSelect(row)}
    >
      <span className={`status-dot ${row.runtime?.status ?? 'unknown'}`} aria-hidden="true" />
      <span className="queue-state">
        <strong>{row.runtime?.status ?? 'unknown'}</strong>
        <time>{durationLabel(row.stats.lastEventAt)}</time>
      </span>
      {scope.fallback ? (
        <span className="queue-scope fallback" title={row.sessionRef.scopeRef}>
          {scope.fallback}
        </span>
      ) : (
        <span className="queue-scope" title={row.sessionRef.scopeRef}>
          <ScopeChip kind="agent" label="agent" value={scope.agent ?? 'n/a'} />
          <ScopeChip kind="project" label="project" value={scope.project ?? 'n/a'} />
          <ScopeChip kind={workLabel} label={workLabel} value={workValue} />
          <ScopeChip kind="lane" label="lane" value={row.sessionRef.laneRef} />
        </span>
      )}
      <span className="queue-meta">
        <span>{row.hostSessionId.slice(0, 7)}</span>
        <span>{row.runtime?.runtimeId?.slice(-5) ?? 'rt_n/a'}</span>
        <span>gen {row.generation}</span>
      </span>
    </button>
  )
}

function ScopeChip({
  kind,
  label,
  value,
}: {
  kind: string
  label: string
  value: string
}) {
  return (
    <span
      className={`scope-chip ${kind}`}
      title={`${label}: ${value}`}
      aria-label={`${label} ${value}`}
    >
      <span className="scope-icon" aria-hidden="true" />
      <b>{value}</b>
    </span>
  )
}
