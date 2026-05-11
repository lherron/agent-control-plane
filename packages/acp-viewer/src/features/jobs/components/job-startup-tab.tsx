import { FieldRow, SectionHeader } from '@/components/primitives'
import type { JobDetailResponse } from '@/types/api'

interface JobStartupTabProps {
  data: JobDetailResponse
}

export function JobStartupTab({ data }: JobStartupTabProps) {
  const { startup } = data
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_2fr] gap-x-16 gap-y-12 max-w-5xl">
      <section>
        <SectionHeader title="Dispatch" />
        <dl>
          <FieldRow label="Scope">
            <span className="mono">{startup.scopeRef}</span>
          </FieldRow>
          <FieldRow label="Lane">
            <span className="mono">{startup.laneRef}</span>
          </FieldRow>
          <FieldRow label="Actor">
            <span className="mono">
              {startup.actor.kind}
              {startup.actor.id ? `:${startup.actor.id}` : ''}
            </span>
          </FieldRow>
        </dl>
      </section>

      <section>
        <SectionHeader title="Input template" />
        <pre className="mono text-[12px] tabular leading-relaxed text-ink overflow-auto max-h-[480px]">
          {JSON.stringify(startup.input, null, 2)}
        </pre>
      </section>
    </div>
  )
}
