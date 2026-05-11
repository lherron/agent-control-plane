export interface ProvenanceItem {
  label: string
  source: string
  timestamp?: string
}

interface ProvenanceStripProps {
  items: ProvenanceItem[]
}

export function ProvenanceStrip({ items }: ProvenanceStripProps) {
  if (items.length === 0) {
    return (
      <div className="border-t border-border bg-workbench px-4 py-2 text-xs text-quiet">
        No state selected
      </div>
    )
  }

  return (
    <div className="border-t border-border bg-workbench px-4 py-2 flex gap-4 text-xs text-muted">
      {items.map((item) => (
        <span key={`${item.label}-${item.source}`}>
          <span className="font-medium text-foreground">{item.label}:</span> {item.source}
          {item.timestamp && <span className="text-quiet ml-1">({item.timestamp})</span>}
        </span>
      ))}
    </div>
  )
}
