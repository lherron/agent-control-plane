import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

export function AgentRawTab({ detail }: Props) {
  return (
    <pre className="max-h-[620px] overflow-auto rounded-md border border-border bg-card p-4 font-mono text-xs">
      {JSON.stringify(detail, null, 2)}
    </pre>
  )
}
