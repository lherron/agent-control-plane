import { cn } from '@/lib/cn'
import type { ProvenanceEntry } from '@/types/api'

export type { ProvenanceEntry }

export interface ProvenanceItem {
  label: string
  source: string
  timestamp?: string
}

interface ProvenanceStripProps {
  items?: ProvenanceItem[]
  provenance?: ProvenanceEntry[]
}

export function ProvenanceStrip({ items, provenance }: ProvenanceStripProps) {
  const hasProvenance = provenance && provenance.length > 0
  const hasItems = items && items.length > 0

  if (!hasProvenance && !hasItems) {
    return (
      <div className="border-t border-border bg-workbench px-4 py-2 text-xs text-quiet">
        No state selected
      </div>
    )
  }

  return (
    <div className="border-t border-border bg-workbench px-4 py-2 flex gap-4 text-xs text-muted overflow-x-auto">
      {hasProvenance &&
        provenance.map((entry) => (
          <span
            key={entry.source}
            className={cn(
              'inline-flex items-center gap-1 whitespace-nowrap',
              entry.available ? 'text-foreground' : 'text-quiet line-through'
            )}
          >
            <span
              className={cn(
                'inline-block w-1.5 h-1.5 rounded-full shrink-0',
                entry.available ? 'bg-green-500' : 'bg-red-400'
              )}
            />
            <span className="font-mono">{entry.source}</span>
            {entry.note && <span className="text-quiet">({entry.note})</span>}
          </span>
        ))}
      {hasItems &&
        items.map((item) => (
          <span key={`${item.label}-${item.source}`}>
            <span className="font-medium text-foreground">{item.label}:</span> {item.source}
            {item.timestamp && <span className="text-quiet ml-1">({item.timestamp})</span>}
          </span>
        ))}
    </div>
  )
}
