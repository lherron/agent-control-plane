import type { SessionTimelineRow } from 'acp-ops-projection'
import { rowKey } from '../../lib/sessionRefs'
import { SessionCard } from './SessionCard'

const ROW_LIMIT = 50

export function SessionQueue({
  rows,
  selectedRowId,
  onSelectRow,
}: {
  rows: SessionTimelineRow[]
  selectedRowId?: string | undefined
  onSelectRow: (row: SessionTimelineRow) => void
}) {
  return (
    <aside className="session-queue" data-testid="session-queue" aria-label="session queue">
      <div className="panel-heading">
        <h2>Session Queue</h2>
        <span>{rows.length} Active</span>
        <button type="button" aria-label="filter sessions">
          ⌁
        </button>
      </div>
      <ol>
        {rows.slice(0, ROW_LIMIT).map((row) => (
          <li key={row.rowId}>
            <SessionCard
              row={row}
              selected={row.rowId === selectedRowId || rowKey(row) === selectedRowId}
              onSelect={onSelectRow}
            />
          </li>
        ))}
      </ol>
      <button type="button" className="view-all">
        View all sessions <span>→</span>
      </button>
    </aside>
  )
}
