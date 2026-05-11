import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Link } from 'react-router-dom'
import {
  getJobCron,
  getJobFlowStepCount,
  getJobId,
  getJobKind,
  getJobNextFireAt,
  getJobProjectId,
} from '../agent-utils'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

export function AgentJobsTab({ detail }: Props) {
  return (
    <section className="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Cron</TableHead>
            <TableHead>Next Fire</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Flow Steps</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.jobs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6}>No assigned jobs found.</TableCell>
            </TableRow>
          ) : (
            detail.jobs.map((job) => {
              const jobId = getJobId(job)
              return (
                <TableRow key={jobId}>
                  <TableCell>
                    <Link
                      to={`/jobs/${encodeURIComponent(jobId)}`}
                      className="font-medium text-primary hover:text-accent"
                    >
                      {job.summary?.title ?? jobId}
                    </Link>
                    <div className="font-mono text-xs text-muted">{jobId}</div>
                  </TableCell>
                  <TableCell>{getJobProjectId(job)}</TableCell>
                  <TableCell className="font-mono text-xs">{getJobCron(job)}</TableCell>
                  <TableCell>{getJobNextFireAt(job)}</TableCell>
                  <TableCell>{getJobKind(job)}</TableCell>
                  <TableCell>{getJobFlowStepCount(job)}</TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
    </section>
  )
}
