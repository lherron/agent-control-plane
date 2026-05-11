import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Link } from 'react-router-dom'
import { formatDateTime } from '../project-utils'
import type { ProjectDetailState } from '../types'

interface Props {
  detail: ProjectDetailState
}

export function ProjectAgentsTab({ detail }: Props) {
  return (
    <section className="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.memberships.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4}>No memberships found.</TableCell>
            </TableRow>
          ) : (
            detail.memberships.map((membership) => (
              <TableRow key={membership.agentId}>
                <TableCell>
                  <Link
                    to={`/agents/${encodeURIComponent(membership.agentId)}`}
                    className="font-medium text-primary hover:text-accent"
                  >
                    {membership.agent?.displayName ?? membership.agentId}
                  </Link>
                  <div className="font-mono text-xs text-muted">{membership.agentId}</div>
                </TableCell>
                <TableCell>{membership.role}</TableCell>
                <TableCell>{membership.status ?? membership.agent?.status ?? 'Unknown'}</TableCell>
                <TableCell>{formatDateTime(membership.createdAt)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  )
}
