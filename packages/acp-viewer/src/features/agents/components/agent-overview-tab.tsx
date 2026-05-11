import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatActor, formatDateTime, heartbeatStatus } from '../agent-utils'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

export function AgentOverviewTab({ detail }: Props) {
  const agent = detail.agent

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="rounded-md">
        <CardHeader>
          <CardTitle>Agent</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <Field label="Display name" value={agent.displayName} />
          <Field label="Agent ID" value={agent.agentId} mono />
          <Field label="Home directory" value={agent.homeDir ?? 'None'} mono />
          <Field label="Status" value={agent.status} />
          <Field label="Heartbeat" value={heartbeatStatus(detail.heartbeat)} />
        </CardContent>
      </Card>

      <Card className="rounded-md">
        <CardHeader>
          <CardTitle>Audit</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <Field label="Created" value={formatDateTime(agent.createdAt)} />
          <Field label="Created by" value={formatActor(agent.createdBy)} />
          <Field label="Updated" value={formatDateTime(agent.updatedAt)} />
          <Field label="Updated by" value={formatActor(agent.updatedBy)} />
        </CardContent>
      </Card>
    </div>
  )
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-3">
      <div className="text-muted">{label}</div>
      <div className={mono ? 'min-w-0 break-words font-mono text-xs' : 'min-w-0 break-words'}>
        {value}
      </div>
    </div>
  )
}
