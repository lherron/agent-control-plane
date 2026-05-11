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

  if (!hasProvenance && !hasItems) return null

  return (
    <footer className="shrink-0 border-t border-border/40 bg-background">
      <div className="px-10 py-2 flex items-center gap-4 overflow-x-auto">
        <span className="kicker text-quiet shrink-0">Source</span>
        <div className="flex items-center gap-4 whitespace-nowrap">
          {hasProvenance &&
            provenance.map((entry, i) => (
              <span
                key={entry.source}
                className={cn(
                  'inline-flex items-center gap-1.5 mono text-[10.5px]',
                  entry.available ? 'text-muted' : 'text-quiet line-through'
                )}
              >
                {i > 0 && <span className="text-quiet/40">·</span>}
                {entry.source}
              </span>
            ))}
          {hasItems &&
            items.map((item) => (
              <span key={`${item.label}-${item.source}`} className="mono text-[10.5px] text-muted">
                {item.label}: {item.source}
              </span>
            ))}
        </div>
      </div>
    </footer>
  )
}
