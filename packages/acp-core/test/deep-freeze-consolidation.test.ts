import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  type WorkflowKernelSnapshot,
  basicWorkflowV1,
  createInMemoryWorkflowKernel,
  deepFreeze,
} from '../src/index.js'

const acpCoreRoot = join(import.meta.dir, '..')

async function readSource(relativePath: string): Promise<string> {
  return await Bun.file(join(acpCoreRoot, relativePath)).text()
}

describe('deep freeze consolidation', () => {
  test('uses one neutral cycle-safe traversal for preset and workflow freezes', async () => {
    const internalHelperPath = 'src/internal/deep-freeze.ts'
    const internalHelper = Bun.file(join(acpCoreRoot, internalHelperPath))

    // T-04517: workflow and preset may keep typed wrappers, but the recursive
    // object traversal belongs in one neutral internal helper.
    expect(await internalHelper.exists()).toBe(true)

    if (!(await internalHelper.exists())) {
      return
    }

    const [helperSource, presetSource, workflowSource] = await Promise.all([
      internalHelper.text(),
      readSource('src/models/preset.ts'),
      readSource('src/workflow/index.ts'),
    ])

    expect(helperSource).toContain('WeakSet<object>')
    expect(helperSource).toMatch(/Object\.values\([^)]*\)/)
    expect(presetSource).not.toMatch(/function\s+deepFreezeValue\b/)
    expect(workflowSource).not.toMatch(/function\s+deepFreeze\s*<[^>]+>\s*\([^)]*\)\s*:\s*T\s*\{/)
    expect(workflowSource).not.toContain("from '../models/preset.js'")
  })

  test('public preset deepFreeze completes on cyclic input and freezes reachable objects', () => {
    const cyclic: {
      label: string
      nested: { count: number }
      self?: unknown
    } = {
      label: 'cyclic',
      nested: { count: 1 },
    }
    cyclic.self = cyclic

    const frozen = deepFreeze(cyclic)

    expect(frozen).toBe(cyclic)
    expect(Object.isFrozen(frozen)).toBe(true)
    expect(Object.isFrozen(frozen.nested)).toBe(true)
    expect(frozen.self).toBe(frozen)
    expect(() => {
      ;(frozen as { label: string }).label = 'mutated'
    }).toThrow()
  })

  test('published and snapshot-restored workflow definitions stay deeply frozen', () => {
    const kernel = createInMemoryWorkflowKernel({ now: '2026-07-06T12:00:00.000Z' })
    const published = kernel.publishWorkflowDefinition(basicWorkflowV1)

    expect(Object.isFrozen(published)).toBe(true)
    expect(Object.isFrozen(published.workflow)).toBe(true)
    expect(Object.isFrozen(published.workflow.initial)).toBe(true)

    const snapshot = kernel.exportSnapshot() as WorkflowKernelSnapshot
    const restored = createInMemoryWorkflowKernel({ snapshot })
    const restoredDefinition = restored.getWorkflowDefinition('basic', 1)

    expect(restoredDefinition).toBeDefined()
    expect(Object.isFrozen(restoredDefinition)).toBe(true)
    expect(Object.isFrozen(restoredDefinition?.workflow)).toBe(true)
    expect(Object.isFrozen(restoredDefinition?.workflow.initial)).toBe(true)
  })
})
