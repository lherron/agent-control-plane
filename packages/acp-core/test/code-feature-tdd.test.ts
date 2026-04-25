import { describe, expect, test } from 'bun:test'

import { getPreset, validateTransition } from '../src/index.js'
import { createEvidence, createTestTask } from './fixtures/in-memory-stores.js'

function createFeatureTask(overrides: Parameters<typeof createTestTask>[0] = {}) {
  return createTestTask({
    workflowPreset: 'code_feature_tdd',
    phase: 'scoped',
    lifecycleState: 'open',
    kind: 'code_change',
    roleMap: {
      owner: 'olivia',
      implementer: 'larry',
      tester: 'curly',
      reviewer: 'riley',
      release_manager: 'rhea',
    },
    ...overrides,
  })
}

describe('code_feature_tdd preset', () => {
  test('first phase transition activates an open scoped task', () => {
    const preset = getPreset('code_feature_tdd', 1)
    const task = createFeatureTask()

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'olivia', role: 'owner' },
      toPhase: 'ready',
      evidence: [createEvidence('scope_bundle')],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.transition.phase).toBe('ready')
      expect(result.transition.lifecycleState).toBe('active')
      expect(result.transition.record.requiredEvidenceKinds).toEqual(['scope_bundle'])
    }
  })

  test('enforces feature TDD evidence gates', () => {
    const preset = getPreset('code_feature_tdd', 1)
    const task = createFeatureTask({ phase: 'ready', lifecycleState: 'active' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'larry', role: 'implementer' },
      toPhase: 'red',
      evidence: [],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('missing_evidence')
      expect(result.error.missingEvidenceKinds).toEqual(['tdd_red_bundle'])
    }
  })

  test('allows qa_bundle or ci_report for refactor -> tested', () => {
    const preset = getPreset('code_feature_tdd', 1)
    const task = createFeatureTask({ phase: 'refactor', lifecycleState: 'active' })

    const qaResult = validateTransition({
      task,
      preset,
      actor: { agentId: 'curly', role: 'tester' },
      toPhase: 'tested',
      evidence: [createEvidence('qa_bundle')],
      expectedVersion: 0,
    })
    const ciResult = validateTransition({
      task,
      preset,
      actor: { agentId: 'curly', role: 'tester' },
      toPhase: 'tested',
      evidence: [createEvidence('ci_report')],
      expectedVersion: 0,
    })

    expect(qaResult.ok).toBe(true)
    expect(ciResult.ok).toBe(true)
    if (qaResult.ok && ciResult.ok) {
      expect(qaResult.transition.record.requiredEvidenceKinds).toEqual(['qa_bundle'])
      expect(ciResult.transition.record.requiredEvidenceKinds).toEqual(['ci_report'])
    }
  })

  test('allows release_ref, deploy_ref, or merge_ref for accepted -> released', () => {
    const preset = getPreset('code_feature_tdd', 1)
    const task = createFeatureTask({ phase: 'accepted', lifecycleState: 'active' })

    for (const evidenceKind of ['release_ref', 'deploy_ref', 'merge_ref']) {
      const result = validateTransition({
        task,
        preset,
        actor: { agentId: 'rhea', role: 'release_manager' },
        toPhase: 'released',
        evidence: [createEvidence(evidenceKind)],
        expectedVersion: 0,
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.transition.phase).toBe('released')
        expect(result.transition.lifecycleState).toBe('active')
        expect(result.transition.record.requiredEvidenceKinds).toEqual([evidenceKind])
      }
    }
  })

  test('released -> completed closes lifecycle without adding a completed phase', () => {
    const preset = getPreset('code_feature_tdd', 1)
    const task = createFeatureTask({ phase: 'released', lifecycleState: 'active' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'olivia', role: 'owner' },
      toPhase: 'completed',
      evidence: [],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.transition.phase).toBe('released')
      expect(result.transition.lifecycleState).toBe('completed')
      expect(result.transition.record.from.phase).toBe('released')
      expect(result.transition.record.to.phase).toBe('released')
    }
  })
})
