import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'
import type { NormalizedFlowStep } from '@/types/api'

interface StepCardProps {
  step: NormalizedFlowStep
  x: number
  y: number
  width: number
  height: number
  selected: boolean
  onSelect: (stepId: string) => void
}

function stepKindLabel(step: NormalizedFlowStep): string {
  if (step.kind === 'exec') return 'exec'
  if (step.inputFile) return 'file'
  return 'agent'
}

export function StepCard({ step, x, y, width, height, selected, onSelect }: StepCardProps) {
  return (
    <foreignObject x={x} y={y} width={width} height={height}>
      <button
        type="button"
        className={cn(
          'h-full w-full rounded-lg border bg-card p-3 cursor-pointer transition-all text-xs text-left',
          selected
            ? 'border-accent ring-2 ring-accent/30 shadow-md'
            : 'border-border hover:border-accent/50 shadow-sm'
        )}
        onClick={() => onSelect(step.id)}
      >
        <div className="flex items-center justify-between gap-1 mb-1">
          <span className="font-semibold text-foreground truncate">{step.id}</span>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
            {stepKindLabel(step)}
          </Badge>
        </div>

        <div className="space-y-0.5 text-quiet">
          {step.timeout && (
            <div className="truncate">
              <span className="text-muted">timeout:</span> {step.timeout}
            </div>
          )}
          {step.fresh !== undefined && (
            <div className="truncate">
              <span className="text-muted">fresh:</span> {String(step.fresh)}
            </div>
          )}
          {step.next && step.next !== 'continue' && (
            <div className="truncate">
              <span className="text-muted">next:</span> {step.next}
            </div>
          )}
          {step.input && (
            <div className="truncate">
              <span className="text-muted">input:</span>{' '}
              {step.input.length > 40 ? `${step.input.slice(0, 37)}...` : step.input}
            </div>
          )}
          {step.kind === 'exec' && step.exec && (
            <div className="truncate">
              <span className="text-muted">exec:</span> {step.exec.argv.join(' ')}
            </div>
          )}
        </div>
      </button>
    </foreignObject>
  )
}
