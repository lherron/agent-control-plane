import { cn } from '@/lib/cn'
import type { NormalizedFlow, NormalizedFlowEdge } from '@/types/api'
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
  continue: '#a59cb0',
  succeed: '#4eb88a',
  fail: '#ef6483',
  onFailure: '#e3a857',
}

const EDGE_LABEL_TEXT: Record<NormalizedFlowEdge['label'], string> = {
  continue: '',
  succeed: 'succeed',
  fail: 'fail',
  onFailure: 'onFailure',
}

function buildOrthogonalPath(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  bendOffset = 16
): string {
  if (Math.abs(startY - endY) < 4) {
    return `M ${startX} ${startY} L ${endX} ${endY}`
  }
  // Step path: out, down, in (with rounded corners)
  const midX = startX + Math.max(bendOffset, (endX - startX) * 0.45)
  const r = 6
  const goingDown = endY > startY
  const corner1 = goingDown ? r : -r
  const corner2 = goingDown ? -r : r
  return [
    `M ${startX} ${startY}`,
    `L ${midX - r} ${startY}`,
    `Q ${midX} ${startY} ${midX} ${startY + corner1}`,
    `L ${midX} ${endY + corner2}`,
    `Q ${midX} ${endY} ${midX + r} ${endY}`,
    `L ${endX} ${endY}`,
  ].join(' ')
}

function Arrow({
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
  const endX = toPos.x - 4
  const endY = toPos.y + config.cardHeight / 2
  const path = buildOrthogonalPath(startX, startY, endX, endY)
  const midX = (startX + endX) / 2
  const midY = (startY + endY) / 2

  const dashed = edge.label === 'onFailure'
  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeDasharray={dashed ? '4 4' : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        markerEnd={`url(#arrow-${edge.label})`}
      />
      {labelText && (
        <g>
          <rect
            x={midX - labelText.length * 3.4 - 5}
            y={midY - 14}
            width={labelText.length * 6.8 + 10}
            height={14}
            rx={2}
            fill="#1f1a2c"
            stroke={color}
            strokeOpacity={0.5}
            strokeWidth={0.6}
          />
          <text
            x={midX}
            y={midY - 4}
            textAnchor="middle"
            fontSize={9}
            fontFamily="JetBrains Mono"
            letterSpacing="0.07em"
            fill={color}
          >
            {labelText.toUpperCase()}
          </text>
        </g>
      )}
    </g>
  )
}

function LaneLabel({
  label,
  y,
  paddingLeft,
  index,
  count,
}: {
  label: string
  y: number
  paddingLeft: number
  index: string
  count: number
}) {
  return (
    <g>
      <line
        x1={paddingLeft - 64}
        x2={paddingLeft - 16}
        y1={y + 0.5}
        y2={y + 0.5}
        stroke="#f0e8dd"
        strokeWidth={1}
      />
      <text
        x={paddingLeft - 64}
        y={y + 18}
        fontSize={11}
        fontWeight={500}
        letterSpacing="0.18em"
        fontFamily="JetBrains Mono"
        fill="#f0e8dd"
      >
        {label.toUpperCase()}
      </text>
      <text
        x={paddingLeft - 64}
        y={y + 32}
        fontSize={9}
        letterSpacing="0.08em"
        fontFamily="JetBrains Mono"
        fill="#a59cb0"
      >
        {index} · {count} step{count === 1 ? '' : 's'}
      </text>
    </g>
  )
}

export function JobFlowCanvas({ flow, selectedStepId, onSelect, className }: JobFlowCanvasProps) {
  const config = DEFAULT_LAYOUT_CONFIG
  const layout = useMemo(() => computeLayout(flow.nodes, config), [flow.nodes, config])
  const hasOnFailure = flow.onFailure.length > 0

  return (
    <div
      className={cn(
        'relative overflow-auto rounded-[3px] border border-border dot-grid',
        className
      )}
    >
      <svg
        width={layout.canvasWidth}
        height={layout.canvasHeight}
        viewBox={`0 0 ${layout.canvasWidth} ${layout.canvasHeight}`}
        className="min-w-full block"
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
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
            </marker>
          ))}
        </defs>

        {/* Lane bands */}
        {flow.sequence.length > 0 && (
          <>
            <rect
              x={0}
              y={config.paddingTop - 12}
              width={layout.canvasWidth}
              height={config.cardHeight + 24}
              fill="#251f33"
              opacity={0.55}
            />
            <LaneLabel
              label="sequence"
              y={config.paddingTop}
              paddingLeft={config.paddingLeft}
              index="01"
              count={flow.sequence.length}
            />
          </>
        )}
        {hasOnFailure && (
          <>
            <rect
              x={0}
              y={config.paddingTop + config.cardHeight + config.verticalGap - 12}
              width={layout.canvasWidth}
              height={config.cardHeight + 24}
              fill="#3a1d24"
              opacity={0.5}
            />
            <LaneLabel
              label="onFailure"
              y={config.paddingTop + config.cardHeight + config.verticalGap}
              paddingLeft={config.paddingLeft}
              index="02"
              count={flow.onFailure.length}
            />
          </>
        )}

        {/* Edges */}
        {flow.edges.map((edge) => {
          const fromPos = layout.positions.get(edge.from)
          const toPos = layout.positions.get(edge.to)
          if (!fromPos || !toPos) return null
          return (
            <Arrow
              key={`${edge.from}-${edge.to}-${edge.label}`}
              edge={edge}
              fromPos={fromPos}
              toPos={toPos}
              config={config}
            />
          )
        })}

        {/* Step cards */}
        {flow.nodes.map((node) => {
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
