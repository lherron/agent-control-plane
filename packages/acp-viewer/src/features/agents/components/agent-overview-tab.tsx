import { FieldRow, SectionHeader } from '@/components/primitives'
import { formatActor, formatDateTime, heartbeatStatus } from '../agent-utils'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

export function AgentOverviewTab({ detail }: Props) {
  const agent = detail.agent
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-16 gap-y-12 max-w-5xl">
      <section>
        <SectionHeader title="Identity" />
        <dl>
          <FieldRow label="Display name">{agent.displayName}</FieldRow>
          <FieldRow label="ID">
            <span className="mono">{agent.agentId}</span>
          </FieldRow>
          <FieldRow label="Home">
            <span className="mono">{agent.homeDir ?? '—'}</span>
          </FieldRow>
          <FieldRow label="Status">{agent.status}</FieldRow>
          <FieldRow label="Heartbeat">{heartbeatStatus(detail.heartbeat)}</FieldRow>
        </dl>
      </section>

      <section>
        <SectionHeader title="Timestamps" />
        <dl>
          <FieldRow label="Created">{formatDateTime(agent.createdAt)}</FieldRow>
          <FieldRow label="Created by">
            <span className="mono">{formatActor(agent.createdBy)}</span>
          </FieldRow>
          <FieldRow label="Updated">{formatDateTime(agent.updatedAt)}</FieldRow>
          <FieldRow label="Updated by">
            <span className="mono">{formatActor(agent.updatedBy)}</span>
          </FieldRow>
        </dl>
      </section>
    </div>
  )
}
