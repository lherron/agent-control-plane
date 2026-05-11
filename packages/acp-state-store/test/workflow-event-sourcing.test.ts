import { describe, expect, test } from 'bun:test'

import { type WorkflowKernelSnapshot, createInMemoryWorkflowKernel } from 'acp-core'

import { openAcpStateStore } from '../src/index.js'

describe('workflow event sourcing persistence', () => {
  test('round-trips replay metadata, rejected commands, and ACP/HRC mappings', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const kernel = createInMemoryWorkflowKernel({ now: '2026-05-11T12:00:00.000Z' })
      kernel.publishWorkflowDefinition({
        id: 'roundtrip',
        version: 1,
        kind: 'test',
        initial: { status: 'open', phase: 'todo' },
        roles: { owner: { binding: 'required' } },
        evidenceKinds: {},
        transitions: {
          start: {
            id: 'start',
            from: { status: 'open', phase: 'todo' },
            to: { status: 'active', phase: 'doing' },
            by: ['owner'],
          },
        },
      })
      const actor = { kind: 'agent' as const, id: 'cody' }
      const created = kernel.createTask({
        taskId: 'task-roundtrip',
        projectId: 'agent-spaces',
        workflow: { id: 'roundtrip', version: 1 },
        goal: 'round trip workflow history',
        roleBindings: { owner: actor },
        idempotencyKey: 'roundtrip:create',
      })
      expect(created.ok).toBe(true)
      const rejected = kernel.applyTransition({
        taskId: 'task-roundtrip',
        transitionId: 'missing',
        actor,
        role: 'owner',
        expectedTaskVersion: 0,
        idempotencyKey: 'roundtrip:missing-transition',
      })
      expect(rejected.ok).toBe(false)
      const mapped = kernel.recordWorkflowHrcRunMap({
        workflowTaskId: 'task-roundtrip',
        hrcRunId: 'hrc-run-roundtrip',
        source: 'reconciled',
        actor,
        idempotencyKey: 'roundtrip:map',
      })
      expect(mapped.ok).toBe(true)

      const snapshot = kernel.exportSnapshot()
      store.workflowRuntime.saveSnapshot(snapshot)
      const reloaded = store.workflowRuntime.loadSnapshot() as WorkflowKernelSnapshot

      expect(reloaded.events.map((event) => [event.workflowSeq, event.type, event.result])).toEqual(
        [
          [1, 'task.created', 'accepted'],
          [2, 'transition.rejected', 'rejected'],
          [3, 'workflow_hrc_run.mapped', 'recorded'],
        ]
      )
      expect(reloaded.events[1]).toMatchObject({
        rejectionCode: 'unknown_transition',
        commandHash: expect.stringMatching(/^sha256:/),
        eventHash: expect.stringMatching(/^sha256:/),
      })
      expect(reloaded.workflowHrcRunMaps).toEqual([
        expect.objectContaining({
          workflowTaskId: 'task-roundtrip',
          hrcRunId: 'hrc-run-roundtrip',
          source: 'reconciled',
        }),
      ])
    } finally {
      store.close()
    }
  })
})
