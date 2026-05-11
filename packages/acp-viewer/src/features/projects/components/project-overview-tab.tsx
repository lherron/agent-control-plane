import { FieldRow, SectionHeader } from '@/components/primitives'
import { formatActor, formatDateTime } from '../project-utils'
import type { ProjectDetailState } from '../types'

interface Props {
  detail: ProjectDetailState
}

export function ProjectOverviewTab({ detail }: Props) {
  const project = detail.project
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-16 gap-y-12 max-w-5xl">
      <section>
        <SectionHeader title="Identity" />
        <dl>
          <FieldRow label="Display name">{project.displayName}</FieldRow>
          <FieldRow label="ID">
            <span className="mono">{project.projectId}</span>
          </FieldRow>
          <FieldRow label="Root">
            <span className="mono">{project.rootDir ?? '—'}</span>
          </FieldRow>
          <FieldRow label="Default agent">
            {detail.defaultAgent?.displayName ?? project.defaultAgentId ?? '—'}
          </FieldRow>
        </dl>
      </section>

      <section>
        <SectionHeader title="Timestamps" />
        <dl>
          <FieldRow label="Created">{formatDateTime(project.createdAt)}</FieldRow>
          <FieldRow label="Created by">
            <span className="mono">{formatActor(project.createdBy)}</span>
          </FieldRow>
          <FieldRow label="Updated">{formatDateTime(project.updatedAt)}</FieldRow>
          <FieldRow label="Updated by">
            <span className="mono">{formatActor(project.updatedBy)}</span>
          </FieldRow>
        </dl>
      </section>
    </div>
  )
}
