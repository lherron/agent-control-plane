import { cn } from '@/lib/cn'
import type { NormalizedFlow, NormalizedFlowEdge, NormalizedFlowStep } from '@/types/api'
import { useMemo } from 'react'
import { DEFAULT_LAYOUT_CONFIG, computeLayout } from './layout'
import { StepCard } from './step-card'

interface JobFlowCanvasProps {
  flow: NormalizedFlow
  selectedStepId: string | null
  onSelect: (stepId: string) => void
  className?: string
}

const EDGE_COLORS: Record<NormalizedFlowEdge['label'], string> = {
  continue: '#94a3b8',
  succeed: '#22c55e',
  fail: '#ef4444',
  onFailure: '#f59e0b',
}

const EDGE_LABEL_TEXT: Record<NormalizedFlowEdge['label'], string> = {
  continue: '',
  succeed: 'succeed',
  fail: 'fail',
  onFailure: 'onFailure',
}

function ArrowPath({
  edge,
  fromPos,
  toPos,
  config,
}: {
  edge: NormalizedFlowEdge
  fromPos: { x: number; y: number }
  toPos: { x: number; y: number }
  config: typeof DEFAULT_LAYOUT_CONFIG
}) {
  const color = EDGE_COLORS[edge.label]
  const labelText = EDGE_LABEL_TEXT[edge.label]

  const startX = fromPos.x + config.cardWidth
  const startY = fromPos.y + config.cardHeight / 2
  const endX = toPos.x
  const endY = toPos.y + config.cardHeight / 2

  // If same row, draw horizontal with a slight curve
  // If different row, draw a path that goes down
  const isHorizontal = Math.abs(startY - endY) < 10

  let path: string
  if (isHorizontal) {
    const midX = (startX + endX) / 2
    path = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`
  } else {
    // Going to a different lane (e.g., onFailure)
    const midX = startX + (endX - startX) * 0.3
    path = `M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`
  }

  const midX = (startX + endX) / 2
  const midY = (startY + endY) / 2

  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray={edge.label === 'onFailure' ? '6 3' : undefined}
        markerEnd={`url(#arrow-${edge.label})`}
      />
      {labelText && (
        <text
          x={midX}
          y={midY - 6}
          textAnchor="middle"
          className="fill-muted text-[10px] font-mono"
        >
          {labelText}
        </text>
      )}
    </g>
  )
}

function LaneLabel({ label, y, paddingLeft }: { label: string; y: number; paddingLeft: number }) {
  return (
    <text
      x={paddingLeft - 4}
      y={y - 8}
      className="fill-muted text-[11px] font-semibold"
      textAnchor="end"
    >
      {label}
    </text>
  )
}

export function JobFlowCanvas({ flow, selectedStepId, onSelect, className }: JobFlowCanvasProps) {
  const config = DEFAULT_LAYOUT_CONFIG

  const layout = useMemo(() => computeLayout(flow.nodes, config), [flow.nodes, config])

  const hasOnFailure = flow.onFailure.length > 0

  return (
    <div className={cn('overflow-auto bg-workbench rounded-lg border border-border', className)}>
      <svg
        width={layout.canvasWidth}
        height={layout.canvasHeight}
        viewBox={`0 0 ${layout.canvasWidth} ${layout.canvasHeight}`}
        className="min-w-full"
        role="img"
        aria-label="Job flow visualization"
      >
        <title>Job flow visualization</title>
        <defs>
          {Object.entries(EDGE_COLORS).map(([label, color]) => (
            <marker
              key={label}
              id={`arrow-${label}`}
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>

        {/* Lane labels */}
        {flow.sequence.length > 0 && (
          <LaneLabel label="sequence" y={config.paddingTop} paddingLeft={config.paddingLeft} />
        )}
        {hasOnFailure && (
          <LaneLabel
            label="onFailure"
            y={config.paddingTop + config.cardHeight + config.verticalGap}
            paddingLeft={config.paddingLeft}
          />
        )}

        {/* Edges (behind cards) */}
        {flow.edges.map((edge) => {
          const fromPos = layout.positions.get(edge.from)
          const toPos = layout.positions.get(edge.to)
          if (!fromPos || !toPos) return null
          return (
            <ArrowPath
              key={`${edge.from}-${edge.to}-${edge.label}`}
              edge={edge}
              fromPos={fromPos}
              toPos={toPos}
              config={config}
            />
          )
        })}

        {/* Step cards */}
        {flow.nodes.map((node: NormalizedFlowStep) => {
          const pos = layout.positions.get(node.id)
          if (!pos) return null
          return (
            <StepCard
              key={node.id}
              step={node}
              x={pos.x}
              y={pos.y}
              width={config.cardWidth}
              height={config.cardHeight}
              selected={selectedStepId === node.id}
              onSelect={onSelect}
            />
          )
        })}
      </svg>
    </div>
  )
}
