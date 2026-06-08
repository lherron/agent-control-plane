import { EmptyState } from '@/components/primitives'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { SessionTimelineRow } from '@/features/sessions/types'
import { RadioTower } from 'lucide-react'
import { SessionCard } from './session-card'

const ROW_LIMIT = 80

export function SessionQueue({
  rows,
  selectedRowId,
  onSelectRow,
}: {
  rows: SessionTimelineRow[]
  selectedRowId?: string | undefined
  onSelectRow: (rowId: string) => void
}) {
  const visibleRows = rows.slice(0, ROW_LIMIT)

  return (
    <aside className="flex min-h-[360px] flex-col border-r border-border bg-paper/50 lg:min-h-0">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="display text-[22px] leading-none text-ink">Session queue</h2>
          <p className="mt-1 text-[12px] text-muted">Most recent hrc sessions</p>
        </div>
        <span className="mono text-[11px] tabular text-accent">{rows.length}</span>
      </header>

      <ScrollArea className="flex-1 p-3">
        {visibleRows.length === 0 ? (
          <div className="grid min-h-[280px] place-items-center">
            <EmptyState
              icon={<RadioTower className="h-8 w-8" />}
              title="No live sessions"
              description="The mobile dashboard has not delivered session rows yet."
            />
          </div>
        ) : (
          <ol className="space-y-2">
            {visibleRows.map((row) => (
              <li key={row.rowId}>
                <SessionCard row={row} selectedRowId={selectedRowId} onSelectRow={onSelectRow} />
              </li>
            ))}
          </ol>
        )}
      </ScrollArea>
    </aside>
  )
}
