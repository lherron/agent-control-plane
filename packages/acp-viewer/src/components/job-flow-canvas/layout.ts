/**
 * Pure layout function for job flow visualization.
 * Returns {x, y} positions for each node ID, arranged as:
 * - sequence lane: horizontal left-to-right
 * - onFailure lane: horizontal left-to-right, below the sequence lane
 */

export interface LayoutNode {
  id: string
  phase: 'sequence' | 'onFailure'
  index: number
}

export interface LayoutPosition {
  x: number
  y: number
}

export interface LayoutConfig {
  cardWidth: number
  cardHeight: number
  horizontalGap: number
  verticalGap: number
  paddingLeft: number
  paddingTop: number
}

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  cardWidth: 252,
  cardHeight: 116,
  horizontalGap: 64,
  verticalGap: 92,
  paddingLeft: 96,
  paddingTop: 56,
}

export interface LayoutResult {
  positions: Map<string, LayoutPosition>
  canvasWidth: number
  canvasHeight: number
}

export function computeLayout(
  nodes: readonly LayoutNode[],
  config: LayoutConfig = DEFAULT_LAYOUT_CONFIG
): LayoutResult {
  const positions = new Map<string, LayoutPosition>()

  const sequenceNodes = nodes
    .filter((n) => n.phase === 'sequence')
    .sort((a, b) => a.index - b.index)
  const onFailureNodes = nodes
    .filter((n) => n.phase === 'onFailure')
    .sort((a, b) => a.index - b.index)

  let maxSequenceX = 0

  for (let i = 0; i < sequenceNodes.length; i++) {
    const x = config.paddingLeft + i * (config.cardWidth + config.horizontalGap)
    const y = config.paddingTop
    positions.set(sequenceNodes[i].id, { x, y })
    maxSequenceX = Math.max(maxSequenceX, x + config.cardWidth)
  }

  const onFailureY = config.paddingTop + config.cardHeight + config.verticalGap

  let maxOnFailureX = 0

  for (let i = 0; i < onFailureNodes.length; i++) {
    const x = config.paddingLeft + i * (config.cardWidth + config.horizontalGap)
    const y = onFailureY
    positions.set(onFailureNodes[i].id, { x, y })
    maxOnFailureX = Math.max(maxOnFailureX, x + config.cardWidth)
  }

  const maxX = Math.max(maxSequenceX, maxOnFailureX)
  const hasOnFailure = onFailureNodes.length > 0
  const canvasHeight = hasOnFailure
    ? onFailureY + config.cardHeight + config.paddingTop
    : config.paddingTop + config.cardHeight + config.paddingTop
  const canvasWidth =
    maxX > 0 ? maxX + config.paddingLeft : config.paddingLeft * 2 + config.cardWidth

  return { positions, canvasWidth, canvasHeight }
}
