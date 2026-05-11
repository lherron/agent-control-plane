import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { AgentDetailState } from '../types'

interface Props {
  detail: AgentDetailState
}

export function AgentScopeTargetsTab({ detail }: Props) {
  return (
    <section className="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Scope</TableHead>
            <TableHead>Lane</TableHead>
            <TableHead>Source</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.scopeTargets.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3}>No scope targets found.</TableCell>
            </TableRow>
          ) : (
            detail.scopeTargets.map((target) => (
              <TableRow key={`${target.scopeRef}:${target.laneRef}:${target.source}`}>
                <TableCell className="font-mono text-xs">{target.scopeRef}</TableCell>
                <TableCell>{target.laneRef}</TableCell>
                <TableCell>{target.source}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  )
}
