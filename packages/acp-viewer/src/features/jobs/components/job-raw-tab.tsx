import type { JobDetailResponse } from '@/types/api'

interface JobRawTabProps {
  data: JobDetailResponse
}

export function JobRawTab({ data }: JobRawTabProps) {
  return (
    <pre className="mono text-[12px] tabular leading-relaxed text-ink overflow-auto max-h-[680px] max-w-5xl">
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}
