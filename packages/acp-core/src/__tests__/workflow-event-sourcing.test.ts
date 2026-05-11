import { describe, expect, test } from 'bun:test'

import { type ActorRef, basicWorkflowV1, createInMemoryWorkflowKernel } from '../index.js'

const owner: ActorRef = { kind: 'agent', id: 'cody' }

function createTask() {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-11T12:00:00.000Z' })
  kernel.publishWorkflowDefinition(basicWorkflowV1)
  const created = kernel.createTask({
    taskId: 'task-event-source',
    projectId: 'agent-spaces',
    workflow: { id: 'basic', version: 1 },
    goal: 'pin workflow event sourcing',
    roleBindings: { owner },
    idempotencyKey: 'event-source:create',
  })
  expect(created.ok).toBe(true)
  if (!created.ok) {
    throw new Error(created.error.message)
  }
  return kernel
}

describe('workflow event sourcing metadata', () => {
  test('records accepted and rejected workflow commands with hashes and stable sequence', () => {
    const kernel = createTask()

    const accepted = kernel.applyTransition({
      taskId: 'task-event-source',
      transitionId: 'start',
      actor: owner,
      role: 'owner',
      expectedTaskVersion: 0,
      idempotencyKey: 'event-source:start',
    })
    expect(accepted.ok).toBe(true)

    const rejected = kernel.applyTransition({
      taskId: 'task-event-source',
      transitionId: 'close_success',
      actor: owner,
      role: 'owner',
      expectedTaskVersion: 1,
      idempotencyKey: 'event-source:close-missing-evidence',
    })
    expect(rejected.ok).toBe(false)

    const events = kernel.listEvents('task-event-source')
    expect(events.map((event) => [event.workflowSeq, event.type, event.result])).toEqual([
      [1, 'task.created', 'accepted'],
      [2, 'transition.applied', 'accepted'],
      [3, 'transition.rejected', 'rejected'],
    ])
    expect(events.every((event) => event.schemaVersion === 1)).toBe(true)
    expect(events.every((event) => event.commandHash?.startsWith('sha256:'))).toBe(true)
    expect(events.every((event) => event.eventHash.startsWith('sha256:'))).toBe(true)
    expect(events[1]?.prevHash).toBe(events[0]?.eventHash)
    expect(events[2]).toMatchObject({
      commandType: 'transition.rejected',
      rejectionCode: 'missing_evidence',
      payload: {
        rejection: expect.objectContaining({ code: 'missing_evidence' }),
        command: expect.objectContaining({
          taskId: 'task-event-source',
          transitionId: 'close_success',
        }),
      },
    })
  })

  test('records explicit ACP to HRC run mappings as workflow events', () => {
    const kernel = createTask()
    const mapped = kernel.recordWorkflowHrcRunMap({
      workflowTaskId: 'task-event-source',
      participantRunId: 'participant-run-1',
      hrcRunId: 'hrc-run-1',
      runtimeId: 'runtime-1',
      launchId: 'launch-1',
      hostSessionId: 'host-session-1',
      scopeRef: 'agent:cody:project:agent-spaces',
      laneRef: 'main',
      generation: 3,
      source: 'launch',
      actor: owner,
      idempotencyKey: 'event-source:map-hrc',
    })

    expect(mapped.ok).toBe(true)
    expect(kernel.listWorkflowHrcRunMaps('task-event-source')).toEqual([
      expect.objectContaining({
        workflowTaskId: 'task-event-source',
        participantRunId: 'participant-run-1',
        hrcRunId: 'hrc-run-1',
        source: 'launch',
      }),
    ])
    expect(kernel.listEvents('task-event-source').at(-1)).toMatchObject({
      type: 'workflow_hrc_run.mapped',
      result: 'recorded',
      payload: expect.objectContaining({ hrcRunId: 'hrc-run-1' }),
    })
  })
})
