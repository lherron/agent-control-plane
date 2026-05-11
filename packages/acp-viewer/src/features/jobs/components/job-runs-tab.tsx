import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { JobDetailResponse } from '@/types/api'

interface JobRunsTabProps {
  data: JobDetailResponse
}

function statusVariant(status: string): 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'succeeded':
      return 'secondary'
    case 'failed':
      return 'destructive'
    default:
      return 'outline'
  }
}

export function JobRunsTab({ data }: JobRunsTabProps) {
  const { latestRuns } = data

  if (latestRuns.length === 0) {
    return <div className="p-4 text-xs text-quiet italic">No recent runs.</div>
  }

  return (
    <div className="p-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run ID</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Triggered By</TableHead>
            <TableHead>Triggered At</TableHead>
            <TableHead>Completed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {latestRuns.map((run) => (
            <TableRow key={run.jobRunId}>
              <TableCell className="font-mono text-xs">{run.jobRunId}</TableCell>
              <TableCell>
                <Badge variant={statusVariant(run.status)} className="text-[10px]">
                  {run.status}
                </Badge>
              </TableCell>
              <TableCell className="text-xs">{run.triggeredBy}</TableCell>
              <TableCell className="text-xs">
                {new Date(run.triggeredAt).toLocaleString()}
              </TableCell>
              <TableCell className="text-xs">
                {run.completedAt ? new Date(run.completedAt).toLocaleString() : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
