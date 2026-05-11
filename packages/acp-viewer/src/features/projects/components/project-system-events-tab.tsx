import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime } from '../project-utils'
import type { ProjectDetailState } from '../types'

interface Props {
  detail: ProjectDetailState
}

export function ProjectSystemEventsTab({ detail }: Props) {
  return (
    <section className="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Payload</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.recentSystemEvents.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3}>No recent system events found.</TableCell>
            </TableRow>
          ) : (
            detail.recentSystemEvents.map((event) => (
              <TableRow key={event.eventId}>
                <TableCell>{formatDateTime(event.occurredAt ?? event.recordedAt ?? event.createdAt)}</TableCell>
                <TableCell>{event.kind}</TableCell>
                <TableCell>
                  <pre className="max-w-[560px] overflow-auto whitespace-pre-wrap font-mono text-xs">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  )
}
