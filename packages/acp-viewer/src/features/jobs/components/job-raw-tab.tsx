import { ScrollArea } from '@/components/ui/scroll-area'
import type { JobDetailResponse } from '@/types/api'

interface JobRawTabProps {
  data: JobDetailResponse
}

export function JobRawTab({ data }: JobRawTabProps) {
  return (
    <div className="p-4">
      <ScrollArea className="max-h-[600px]">
        <pre className="bg-secondary rounded p-3 text-foreground whitespace-pre-wrap font-mono text-[11px]">
          {JSON.stringify(data, null, 2)}
        </pre>
      </ScrollArea>
    </div>
  )
}
