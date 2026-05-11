import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '../agent-utils'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
  loading: boolean
}

export function AgentHeartbeatTab({ detail, loading }: Props) {
  const heartbeat = detail.heartbeat

  if (loading && heartbeat === undefined) {
    return <div className="text-sm text-muted">Loading heartbeat...</div>
  }

  if (heartbeat === undefined || heartbeat === null) {
    return (
      <Card className="rounded-md">
        <CardContent className="p-6 text-sm text-muted">No heartbeat recorded.</CardContent>
      </Card>
    )
  }

  return (
    <Card className="rounded-md">
      <CardHeader>
        <CardTitle>Heartbeat</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <Field label="Status" value={heartbeat.status} />
        <Field label="Last seen" value={formatDateTime(heartbeat.lastHeartbeatAt)} />
        <Field label="Source" value={heartbeat.source ?? 'None'} />
        <Field label="Note" value={heartbeat.lastNote ?? 'None'} />
        <Field label="Target scope" value={heartbeat.targetScopeRef ?? 'None'} mono />
        <Field label="Target lane" value={heartbeat.targetLaneRef ?? 'None'} />
      </CardContent>
    </Card>
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
