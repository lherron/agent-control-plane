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
  const isOnFailure = step.phase === 'onFailure'
  const stepNumber = step.index + 1
  return (
    <foreignObject x={x} y={y} width={width} height={height} style={{ pointerEvents: 'auto' }}>
      <button
        type="button"
        className={cn(
          'h-full w-full rounded-lg border bg-card cursor-pointer transition-all text-xs text-left overflow-hidden flex flex-col',
          selected
            ? 'border-accent ring-2 ring-accent/40 shadow-md'
            : 'border-border hover:border-accent/60 shadow-sm'
        )}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(step.id)
        }}
      >
        <div
          className={cn(
            'px-3 py-1.5 flex items-center justify-between gap-1 border-b',
            isOnFailure
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-accent/10 border-accent/30 text-accent'
          )}
        >
          <span className="font-semibold truncate text-[11px] uppercase tracking-wide">
            Step {stepNumber} · {step.id}
          </span>
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] px-1.5 py-0 shrink-0 bg-card',
              isOnFailure ? 'border-red-300 text-red-700' : 'border-accent/40 text-accent'
            )}
          >
            {stepKindLabel(step)}
          </Badge>
        </div>

        <div className="space-y-0.5 text-quiet px-3 py-2 flex-1 min-h-0 overflow-hidden">
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
            <div className="truncate text-foreground/80">
              <span className="text-muted">input:</span>{' '}
              {step.input.length > 50 ? `${step.input.slice(0, 47)}...` : step.input}
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
