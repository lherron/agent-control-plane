import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Link } from 'react-router-dom'
import { formatDateTime } from '../agent-utils'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

export function AgentProjectsTab({ detail }: Props) {
  return (
    <section className="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Project</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Default Agent</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.memberships.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4}>No project memberships found.</TableCell>
            </TableRow>
          ) : (
            detail.memberships.map((membership) => (
              <TableRow key={membership.projectId}>
                <TableCell>
                  <Link
                    to={`/projects/${encodeURIComponent(membership.projectId)}`}
                    className="font-medium text-primary hover:text-accent"
                  >
                    {membership.project?.displayName ?? membership.projectId}
                  </Link>
                  <div className="font-mono text-xs text-muted">{membership.projectId}</div>
                </TableCell>
                <TableCell>{membership.role}</TableCell>
                <TableCell>{membership.isDefaultAgent ? 'Yes' : 'No'}</TableCell>
                <TableCell>{formatDateTime(membership.createdAt)}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  )
}
