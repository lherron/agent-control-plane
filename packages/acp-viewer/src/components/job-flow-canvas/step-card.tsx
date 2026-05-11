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
        onClick={(e) => {
          e.stopPropagation()
          onSelect(step.id)
        }}
        className={cn(
          'h-full w-full text-left bg-card transition-all duration-150 flex flex-col overflow-hidden relative',
          'border rounded-[3px] focus:outline-none',
          selected
            ? 'border-accent shadow-[0_0_0_3px_rgba(227,168,87,0.22),0_2px_8px_rgba(0,0,0,0.3)]'
            : isOnFailure
              ? 'border-[#5a2c38] hover:border-[#ef6483]/70 shadow-[0_1px_2px_rgba(0,0,0,0.3)]'
              : 'border-border hover:border-accent/40 shadow-[0_1px_2px_rgba(0,0,0,0.3)]'
        )}
      >
        {/* Phase strip */}
        <span
          className={cn(
            'absolute left-0 top-0 bottom-0 w-[3px]',
            isOnFailure ? 'bg-[#ef6483]' : 'brass-foil'
          )}
        />

        <div
          className={cn(
            'flex items-center justify-between gap-2 pl-3 pr-2.5 py-1.5 border-b',
            isOnFailure
              ? 'bg-[#3a1d24]/60 border-[#5a2c38]/60'
              : 'bg-[#3a2d18]/50 border-[#5a4520]/40'
          )}
        >
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="mono text-[9px] tabular text-quiet shrink-0">
              {String(stepNumber).padStart(2, '0')}
            </span>
            <span
              className={cn(
                'mono text-[11px] uppercase tracking-wider truncate font-medium',
                isOnFailure ? 'text-[#f7a5b8]' : 'text-[#f0c483]'
              )}
            >
              {step.id}
            </span>
          </div>
          <span
            className={cn(
              'mono text-[9px] uppercase tracking-wider px-1 py-px border rounded-[2px] shrink-0',
              isOnFailure
                ? 'bg-paper border-[#5a2c38] text-[#f7a5b8]'
                : 'bg-paper border-[#5a4520] text-[#f0c483]'
            )}
          >
            {stepKindLabel(step)}
          </span>
        </div>

        <div className="flex flex-col px-3 py-2 gap-[3px] text-[11px] leading-tight flex-1 min-h-0 overflow-hidden">
          {step.timeout && <Row k="timeout" v={step.timeout} />}
          {step.fresh !== undefined && <Row k="fresh" v={String(step.fresh)} />}
          {step.next && step.next !== 'continue' && <Row k="next" v={step.next} accent />}
          {step.input && (
            <Row
              k="input"
              v={step.input.length > 60 ? `${step.input.slice(0, 57)}…` : step.input}
            />
          )}
          {step.kind === 'exec' && step.exec && <Row k="exec" v={step.exec.argv.join(' ')} />}
        </div>
      </button>
    </foreignObject>
  )
}

function Row({ k, v, accent = false }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="mono text-[9.5px] uppercase tracking-wider text-quiet shrink-0">{k}</span>
      <span
        className={cn('mono text-[11px] truncate', accent ? 'text-accent font-medium' : 'text-ink')}
      >
        {v}
      </span>
    </div>
  )
}
