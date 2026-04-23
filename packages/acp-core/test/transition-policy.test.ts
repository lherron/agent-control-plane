import { describe, expect, test } from 'bun:test'

import {
  deriveLifecycleStateAfterTransition,
  getPreset,
  isLifecycleTarget,
  validateTransition,
} from '../src/index.js'
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
        agentId: task.roleMap['implementer'] ?? 'larry',
        role: 'tester',
        scopeRef: `agent:${task.roleMap['implementer'] ?? 'larry'}:project:${task.projectId}:task:${task.taskId}:role:tester`,
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

  test('allows medium-risk verification by an independent tester-role actor', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'green', riskClass: 'medium' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'mallory', role: 'tester' },
      toPhase: 'verified',
      evidence: [createEvidence('qa_bundle')],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.transition.phase).toBe('verified')
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

  test('allows verified -> completed as lifecycle-only (phase stays verified)', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({ phase: 'verified', riskClass: 'medium' })

    const result = validateTransition({
      task,
      preset,
      actor: { agentId: 'larry', role: 'implementer' },
      toPhase: 'completed',
      evidence: [],
      expectedVersion: 0,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.transition.phase).toBe('verified')
      expect(result.transition.lifecycleState).toBe('completed')
    }
  })
})

describe('lifecycle/phase separation', () => {
  test('isLifecycleTarget identifies completed and active as lifecycle targets', () => {
    expect(isLifecycleTarget('completed')).toBe(true)
    expect(isLifecycleTarget('active')).toBe(true)
    expect(isLifecycleTarget('red')).toBe(false)
    expect(isLifecycleTarget('green')).toBe(false)
    expect(isLifecycleTarget('verified')).toBe(false)
  })

  test('phase transition while lifecycle is open activates the task', () => {
    const task = createTestTask({ lifecycleState: 'open', phase: 'red' })
    const lifecycle = deriveLifecycleStateAfterTransition(task, 'green')
    expect(lifecycle).toBe('active')
  })

  test('phase transition while lifecycle is active keeps it active', () => {
    const task = createTestTask({ lifecycleState: 'active', phase: 'green' })
    const lifecycle = deriveLifecycleStateAfterTransition(task, 'verified')
    expect(lifecycle).toBe('active')
  })

  test('lifecycle-only completed transition changes lifecycle but not phase', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    const task = createTestTask({
      phase: 'verified',
      lifecycleState: 'active',
      riskClass: 'low',
    })

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
      expect(result.transition.phase).toBe('verified')
      expect(result.transition.lifecycleState).toBe('completed')
      expect(result.transition.record.from.phase).toBe('verified')
      expect(result.transition.record.to.phase).toBe('verified')
    }
  })

  test('phaseGraph contains only real phases, not lifecycle labels', () => {
    const preset = getPreset('code_defect_fastlane', 1)
    expect(preset.phaseGraph).toEqual(['red', 'green', 'verified'])
    expect(preset.phaseGraph).not.toContain('open')
    expect(preset.phaseGraph).not.toContain('completed')
  })

  test('full lifecycle red -> green -> verified -> completed proceeds independently', () => {
    const preset = getPreset('code_defect_fastlane', 1)

    // Start at red, lifecycle open
    const taskAtRed = createTestTask({
      phase: 'red',
      lifecycleState: 'open',
      riskClass: 'low',
    })

    // Transition red -> green
    const redToGreen = validateTransition({
      task: taskAtRed,
      preset,
      actor: { agentId: 'larry', role: 'implementer' },
      toPhase: 'green',
      evidence: [createEvidence('tdd_green_bundle')],
      expectedVersion: 0,
    })

    expect(redToGreen.ok).toBe(true)
    if (redToGreen.ok) {
      expect(redToGreen.transition.phase).toBe('green')
      expect(redToGreen.transition.lifecycleState).toBe('active')
    }

    // Transition green -> verified
    const taskAtGreen = createTestTask({
      phase: 'green',
      lifecycleState: 'active',
      riskClass: 'low',
      version: 1,
    })
    const greenToVerified = validateTransition({
      task: taskAtGreen,
      preset,
      actor: { agentId: 'larry', role: 'implementer' },
      toPhase: 'verified',
      evidence: [createEvidence('qa_bundle')],
      expectedVersion: 1,
    })

    expect(greenToVerified.ok).toBe(true)
    if (greenToVerified.ok) {
      expect(greenToVerified.transition.phase).toBe('verified')
      expect(greenToVerified.transition.lifecycleState).toBe('active')
    }

    // Transition verified -> completed (lifecycle-only)
    const taskAtVerified = createTestTask({
      phase: 'verified',
      lifecycleState: 'active',
      riskClass: 'low',
      version: 2,
    })
    const verifiedToCompleted = validateTransition({
      task: taskAtVerified,
      preset,
      actor: { agentId: 'olivia', role: 'owner' },
      toPhase: 'completed',
      evidence: [],
      expectedVersion: 2,
    })

    expect(verifiedToCompleted.ok).toBe(true)
    if (verifiedToCompleted.ok) {
      expect(verifiedToCompleted.transition.phase).toBe('verified')
      expect(verifiedToCompleted.transition.lifecycleState).toBe('completed')
    }
  })
})
