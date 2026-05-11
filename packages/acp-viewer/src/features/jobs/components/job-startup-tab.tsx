import type { JobDetailResponse } from '@/types/api'

interface JobStartupTabProps {
  data: JobDetailResponse
}

export function JobStartupTab({ data }: JobStartupTabProps) {
  const { startup } = data

  return (
    <div className="space-y-4 p-4 text-xs">
      <div>
        <span className="text-muted">Scope Ref:</span>{' '}
        <span className="font-mono text-foreground">{startup.scopeRef}</span>
      </div>
      <div>
        <span className="text-muted">Lane Ref:</span>{' '}
        <span className="font-mono text-foreground">{startup.laneRef}</span>
      </div>
      <div>
        <span className="text-muted">Actor:</span>{' '}
        <span className="font-mono text-foreground">
          {startup.actor.kind}
          {startup.actor.id ? `:${startup.actor.id}` : ''}
        </span>
      </div>
      <div>
        <div className="text-muted mb-1">Input Template:</div>
        <pre className="bg-secondary rounded p-3 text-foreground whitespace-pre-wrap font-mono text-[11px] max-h-80 overflow-auto">
          {JSON.stringify(startup.input, null, 2)}
        </pre>
      </div>
    </div>
  )
}
