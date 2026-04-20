import { describe, expect, test } from 'bun:test'

import { computeTaskContext, getPreset } from '../src/index.js'
import { createTestTask } from './fixtures/in-memory-stores.js'

describe('computeTaskContext', () => {
  test('collects required evidence for a medium-risk tester in green phase', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'green', riskClass: 'medium' })

    const context = computeTaskContext({ preset, task, role: 'tester' })

    expect(context.phase).toBe('green')
    expect(context.requiredEvidenceKinds).toEqual(['qa_bundle'])
    expect(context.hintsText).toContain(
      'Objective: Ship the smallest fix that makes the repro pass.'
    )
    expect(context.hintsText.length).toBeLessThanOrEqual(1536)
  })

  test('returns no outbound evidence for roles that cannot leave the phase', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'green', riskClass: 'medium' })

    const context = computeTaskContext({ preset, task, role: 'implementer' })

    expect(context.requiredEvidenceKinds).toEqual([])
  })

  test('includes self-verification evidence for low-risk implementers', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'green', riskClass: 'low' })

    const context = computeTaskContext({ preset, task, role: 'implementer' })

    expect(context.requiredEvidenceKinds).toEqual(['qa_bundle'])
    expect(context.hintsText).toContain('Agent hints:')
  })
})
