import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Link } from 'react-router-dom'
import {
  formatBoolean,
  getJobAgentId,
  getJobCron,
  getJobDisabled,
  getJobFlowStepCount,
  getJobId,
  getJobKind,
  getJobNextFireAt,
} from '../project-utils'
import type { ProjectDetailState } from '../types'

interface Props {
  detail: ProjectDetailState
}

export function ProjectJobsTab({ detail }: Props) {
  return (
    <section className="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Job</TableHead>
            <TableHead>Agent</TableHead>
            <TableHead>Disabled</TableHead>
            <TableHead>Cron</TableHead>
            <TableHead>Next Fire</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Flow Steps</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.jobs.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7}>No jobs found.</TableCell>
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
                  <TableCell>{getJobAgentId(job)}</TableCell>
                  <TableCell>{formatBoolean(getJobDisabled(job))}</TableCell>
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
