import { describe, expect, it } from 'bun:test'
import { computeLayout, DEFAULT_LAYOUT_CONFIG } from '../src/components/job-flow-canvas/layout'
import type { LayoutNode } from '../src/components/job-flow-canvas/layout'

describe('job-flow-canvas layout', () => {
  it('returns empty positions for no nodes', () => {
    const result = computeLayout([])
    expect(result.positions.size).toBe(0)
    expect(result.canvasWidth).toBeGreaterThan(0)
    expect(result.canvasHeight).toBeGreaterThan(0)
  })

  it('lays out a single sequence node at padding offset', () => {
    const nodes: LayoutNode[] = [{ id: 'step-1', phase: 'sequence', index: 0 }]
    const result = computeLayout(nodes)

    const pos = result.positions.get('step-1')
    expect(pos).toBeDefined()
    expect(pos!.x).toBe(DEFAULT_LAYOUT_CONFIG.paddingLeft)
    expect(pos!.y).toBe(DEFAULT_LAYOUT_CONFIG.paddingTop)
  })

  it('arranges sequence nodes left-to-right', () => {
    const nodes: LayoutNode[] = [
      { id: 'a', phase: 'sequence', index: 0 },
      { id: 'b', phase: 'sequence', index: 1 },
      { id: 'c', phase: 'sequence', index: 2 },
    ]
    const result = computeLayout(nodes)

    const posA = result.positions.get('a')!
    const posB = result.positions.get('b')!
    const posC = result.positions.get('c')!

    expect(posA.x).toBeLessThan(posB.x)
    expect(posB.x).toBeLessThan(posC.x)

    // All at same y
    expect(posA.y).toBe(posB.y)
    expect(posB.y).toBe(posC.y)
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

  it('computes correct horizontal spacing', () => {
    const nodes: LayoutNode[] = [
      { id: 'a', phase: 'sequence', index: 0 },
      { id: 'b', phase: 'sequence', index: 1 },
    ]
    const config = DEFAULT_LAYOUT_CONFIG
    const result = computeLayout(nodes, config)

    const posA = result.positions.get('a')!
    const posB = result.positions.get('b')!

    expect(posB.x - posA.x).toBe(config.cardWidth + config.horizontalGap)
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

  it('works with custom config', () => {
    const nodes: LayoutNode[] = [
      { id: 'x', phase: 'sequence', index: 0 },
    ]
    const customConfig = {
      cardWidth: 100,
      cardHeight: 50,
      horizontalGap: 40,
      verticalGap: 30,
      paddingLeft: 20,
      paddingTop: 10,
    }
    const result = computeLayout(nodes, customConfig)

    const pos = result.positions.get('x')!
    expect(pos.x).toBe(20)
    expect(pos.y).toBe(10)
  })
})
