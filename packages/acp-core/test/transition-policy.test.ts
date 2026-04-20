import { describe, expect, test } from 'bun:test'

import { getPreset, validateTransition } from '../src/index.js'
import { createEvidence, createTestTask, createWaiver } from './fixtures/in-memory-stores.js'

describe('validateTransition', () => {
  test('rejects unknown transitions', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'verified' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'olivia', role: 'owner' },
      toPhase: 'red',
      evidence: [],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('unknown_transition')
    }
  })

  test('rejects roles that are not allowed by the transition rule', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'red' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'curly', role: 'tester' },
      toPhase: 'green',
      evidence: [createEvidence('tdd_green_bundle')],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('role_not_allowed')
    }
  })

  test('rejects medium-risk self-verification by the implementer agent', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'green', riskClass: 'medium' })

    const result = validateTransition({
      task,
      preset,
      actor: {
        agentId: task.roleMap.implementer ?? 'larry',
        role: 'tester',
        scopeRef: `agent:${task.roleMap.implementer ?? 'larry'}:project:${task.projectId}:task:${task.taskId}:role:tester`,
      },
      toPhase: 'verified',
      evidence: [createEvidence('qa_bundle')],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('sod_violation')
    }
  })

  test('rejects missing evidence when no waiver is supplied', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'red' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'larry', role: 'implementer' },
      toPhase: 'green',
      evidence: [],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('missing_evidence')
      expect(result.error.missingEvidenceKinds).toEqual(['tdd_green_bundle'])
    }
  })

  test('rejects invalid waivers when evidence is still missing', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'red' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'larry', role: 'implementer' },
      toPhase: 'green',
      evidence: [],
      expectedVersion: 0,
      waivers: [
        createWaiver({
          waiverKind: 'evidence_override',
          scope: 'qa_bundle',
          expiresAt: '2999-01-01T00:00:00Z',
        }),
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('no_waiver')
      expect(result.error.missingEvidenceKinds).toEqual(['tdd_green_bundle'])
    }
  })

  test('rejects stale expectedVersion values', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'red', version: 3 })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'larry', role: 'implementer' },
      toPhase: 'green',
      evidence: [createEvidence('tdd_green_bundle')],
      expectedVersion: 2,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('version_conflict')
    }
  })

  test('accepts a valid evidence waiver', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'red' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'larry', role: 'implementer' },
      toPhase: 'green',
      evidence: [],
      expectedVersion: 0,
      waivers: [
        createWaiver({
          waiverKind: 'evidence_override',
          scope: 'tdd_green_bundle',
          expiresAt: '2999-01-01T00:00:00Z',
        }),
      ],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.transition.phase).toBe('green')
      expect(result.transition.record.waivedEvidenceKinds).toEqual(['tdd_green_bundle'])
    }
  })

  test('allows low-risk implementer self-verification', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'green', riskClass: 'low' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'larry', role: 'implementer' },
      toPhase: 'verified',
      evidence: [createEvidence('qa_bundle')],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.transition.phase).toBe('verified')
    }
  })
})
