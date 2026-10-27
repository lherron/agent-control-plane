import { describe, expect, it } from 'bun:test'
import { DEFAULT_LAYOUT_CONFIG, computeLayout } from '../src/components/job-flow-canvas/layout'
import type { LayoutNode } from '../src/components/job-flow-canvas/layout'

describe('job-flow-canvas layout', () => {
  it('returns empty positions for no nodes', () => {
    const result = computeLayout([])
    expect(result.positions.size).toBe(0)
    expect(result.canvasWidth).toBeGreaterThan(0)
    expect(result.canvasHeight).toBeGreaterThan(0)
  })

  const customConfig = {
    cardWidth: 100,
    cardHeight: 50,
    horizontalGap: 40,
    verticalGap: 30,
    paddingLeft: 20,
    paddingTop: 10,
  }

  it.each([
    ['the default config', DEFAULT_LAYOUT_CONFIG],
    ['a custom config', customConfig],
  ])('lays out a single sequence node at the padding offset of %s', (_name, config) => {
    const nodes: LayoutNode[] = [{ id: 'step-1', phase: 'sequence', index: 0 }]
    const result = computeLayout(nodes, config)

    const pos = result.positions.get('step-1')
    expect(pos).toBeDefined()
    expect(pos!.x).toBe(config.paddingLeft)
    expect(pos!.y).toBe(config.paddingTop)
  })

  it('places onFailure nodes below sequence nodes', () => {
    const nodes: LayoutNode[] = [
      { id: 'seq-1', phase: 'sequence', index: 0 },
      { id: 'fail-1', phase: 'onFailure', index: 0 },
    ]
    const result = computeLayout(nodes)

    const seqPos = result.positions.get('seq-1')!
    const failPos = result.positions.get('fail-1')!

    expect(failPos.y).toBeGreaterThan(seqPos.y)
    expect(failPos.x).toBe(seqPos.x) // Same x for index 0
  })

  it('places sequence nodes left-to-right one card plus gap apart on one row', () => {
    const nodes: LayoutNode[] = [
      { id: 'a', phase: 'sequence', index: 0 },
      { id: 'b', phase: 'sequence', index: 1 },
      { id: 'c', phase: 'sequence', index: 2 },
    ]
    const config = DEFAULT_LAYOUT_CONFIG
    const result = computeLayout(nodes, config)
    const step = config.cardWidth + config.horizontalGap

    nodes.forEach((node, index) => {
      const pos = result.positions.get(node.id)!
      expect(pos.x).toBe(config.paddingLeft + index * step)
      expect(pos.y).toBe(config.paddingTop)
    })
  })

  it('canvas dimensions accommodate all nodes', () => {
    const nodes: LayoutNode[] = [
      { id: 'a', phase: 'sequence', index: 0 },
      { id: 'b', phase: 'sequence', index: 1 },
      { id: 'c', phase: 'onFailure', index: 0 },
    ]
    const result = computeLayout(nodes)

    // Canvas width should cover the rightmost card
    const posB = result.positions.get('b')!
    expect(result.canvasWidth).toBeGreaterThanOrEqual(posB.x + DEFAULT_LAYOUT_CONFIG.cardWidth)

    // Canvas height should cover onFailure row
    const posC = result.positions.get('c')!
    expect(result.canvasHeight).toBeGreaterThanOrEqual(posC.y + DEFAULT_LAYOUT_CONFIG.cardHeight)
  })
})
