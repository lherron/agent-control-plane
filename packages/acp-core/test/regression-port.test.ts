import { describe, expect, test } from 'bun:test'

import { getPreset } from '../src/index.js'
import {
  InMemoryAcpWorkflowStore,
  createEvidence,
  createTestTask,
} from './fixtures/in-memory-stores.js'

describe('task-core regression port', () => {
  test('task CRUD preserves version 0 and preset pinning', () => {
    const store = new InMemoryAcpWorkflowStore()

    store.createTask(createTestTask({ taskId: 'task-001', phase: 'red' }))

    const task = store.getTask('task-001')

    expect(task).toBeDefined()
    expect(task?.version).toBe(0)
    expect(task?.workflowPreset).toBe('code_defect_fastlane')
    expect(task?.presetVersion).toBe(1)
  })

  test('versioned transitions advance monotonically', () => {
    const store = new InMemoryAcpWorkflowStore()
    store.createTask(createTestTask({ taskId: 'task-002', phase: 'red' }))

    const first = store.transition('task-002', {
      toPhase: 'green',
      actor: { agentId: 'larry', role: 'implementer' },
      evidence: [createEvidence('tdd_green_bundle')],
      expectedVersion: 0,
    })
    const second = store.transition('task-002', {
      toPhase: 'verified',
      actor: { agentId: 'curly', role: 'tester' },
      evidence: [createEvidence('qa_bundle')],
      expectedVersion: 1,
    })

    expect('task' in first).toBe(true)
    expect('task' in second).toBe(true)
    if ('task' in second) {
      expect(second.task.version).toBe(2)
      expect(second.task.phase).toBe('verified')
    }
  })

  test('stale expectedVersion detects version conflicts', () => {
    const store = new InMemoryAcpWorkflowStore()
    store.createTask(createTestTask({ taskId: 'task-003', phase: 'red' }))

    const first = store.transition('task-003', {
      toPhase: 'green',
      actor: { agentId: 'larry', role: 'implementer' },
      evidence: [createEvidence('tdd_green_bundle')],
      expectedVersion: 0,
    })
    expect('task' in first).toBe(true)

    const stale = store.transition('task-003', {
      toPhase: 'verified',
      actor: { agentId: 'curly', role: 'tester' },
      evidence: [createEvidence('qa_bundle')],
      expectedVersion: 0,
    })

    expect('error' in stale).toBe(true)
    if ('error' in stale) {
      expect(stale.error.code).toBe('version_conflict')
    }
  })

  test('preset-driven transitions require evidence', () => {
    const store = new InMemoryAcpWorkflowStore()
    store.createTask(createTestTask({ taskId: 'task-004', phase: 'red' }))

    const result = store.transition('task-004', {
      toPhase: 'green',
      actor: { agentId: 'larry', role: 'implementer' },
      evidence: [],
      expectedVersion: 0,
    })

    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.code).toBe('missing_evidence')
      expect(result.error.missingEvidenceKinds).toEqual(['tdd_green_bundle'])
    }
  })

  test('preset objects are immutable and task pins survive transitions', () => {
    const store = new InMemoryAcpWorkflowStore()
    store.createTask(createTestTask({ taskId: 'task-005', phase: 'red' }))

    const result = store.transition('task-005', {
      toPhase: 'green',
      actor: { agentId: 'larry', role: 'implementer' },
      evidence: [createEvidence('tdd_green_bundle')],
      expectedVersion: 0,
    })
    const preset = getPreset('code_defect_fastlane', 1)
    const task = store.getTask('task-005')

    expect(Object.isFrozen(preset)).toBe(true)
    expect(Object.isFrozen(preset.guidance['green']?.agentHints)).toBe(true)
    expect(() => {
      ;(preset.transitionPolicy as unknown as Array<{ toPhase: string }>).push({ toPhase: 'oops' })
    }).toThrow()
    expect('task' in result).toBe(true)
    expect(task?.workflowPreset).toBe('code_defect_fastlane')
    expect(task?.presetVersion).toBe(1)
  })

  test('transition history is recorded in order and unknown tasks return NOT_FOUND', () => {
    const store = new InMemoryAcpWorkflowStore()
    store.createTask(createTestTask({ taskId: 'task-006', phase: 'red' }))

    store.transition('task-006', {
      toPhase: 'green',
      actor: { agentId: 'larry', role: 'implementer' },
      evidence: [createEvidence('tdd_green_bundle')],
      expectedVersion: 0,
    })
    store.transition('task-006', {
      toPhase: 'verified',
      actor: { agentId: 'curly', role: 'tester' },
      evidence: [createEvidence('qa_bundle')],
      expectedVersion: 1,
    })

    const transitions = store.getTransitions('task-006')
    const notFound = store.getTransitions('missing-task')

    expect('transitions' in transitions).toBe(true)
    if ('transitions' in transitions) {
      expect(transitions.transitions).toHaveLength(2)
      expect(transitions.transitions[0]?.from.phase).toBe('red')
      expect(transitions.transitions[0]?.to.phase).toBe('green')
      expect(transitions.transitions[0]?.transitionEventId).toBeTruthy()
      expect(transitions.transitions[0]?.timestamp).toBeTruthy()
      expect(transitions.transitions[1]?.to.phase).toBe('verified')
      expect(transitions.transitions[1]?.actor.agentId).toBe('curly')
    }

    expect('error' in notFound).toBe(true)
    if ('error' in notFound) {
      expect(notFound.error.code).toBe('NOT_FOUND')
    }
  })
})
