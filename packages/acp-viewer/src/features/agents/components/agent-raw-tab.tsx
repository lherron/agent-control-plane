import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

export function AgentRawTab({ detail }: Props) {
  return (
    <pre className="mono text-[12px] leading-relaxed text-ink overflow-auto max-h-[680px] max-w-5xl">
      {JSON.stringify(detail, null, 2)}
    </pre>
  )
}
