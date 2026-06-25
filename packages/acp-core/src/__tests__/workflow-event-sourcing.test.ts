import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  type WorkflowDefinition,
  basicWorkflowV1,
  createInMemoryWorkflowKernel,
} from '../index.js'

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

  test('preserves legacy hashes and stored shape for undefined workflow state keys', () => {
    const kernel = createInMemoryWorkflowKernel({ now: '2026-05-11T12:00:00.000Z' })
    const definition: WorkflowDefinition = {
      id: 'undefined_hash_fixture',
      version: 1,
      kind: 'test',
      initial: { status: 'open', phase: undefined },
      roles: {
        owner: { description: undefined, binding: 'required' },
      },
      evidenceKinds: {},
      transitions: {},
    }

    const published = kernel.publishWorkflowDefinition(definition)
    const created = kernel.createTask({
      taskId: 'task-undefined-hash',
      projectId: 'agent-spaces',
      workflow: { id: 'undefined_hash_fixture', version: 1 },
      goal: 'pin undefined hash behavior',
      roleBindings: { owner },
      idempotencyKey: 'undefined-hash:create',
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error(created.error.message)
    }

    const launched = (kernel as any).startParticipantRun({
      taskId: 'task-undefined-hash',
      role: 'owner',
      actor: owner,
      idempotencyKey: 'undefined-hash:participant',
    })
    expect(launched.ok).toBe(true)
    if (!launched.ok) {
      throw new Error(launched.error.message)
    }

    const events = kernel.listEvents('task-undefined-hash')
    expect(published.hash).toBe(
      'sha256:9f63b77c5a2a6cba7852230511112fe8e67de2ff492a07228ce941db18f526b6'
    )
    expect(events[0]?.eventHash).toBe(
      'sha256:e00cca48d9ad6186cf01355c7c3ac9476bdfff0ee7587a041d6285af0e6736ba'
    )
    expect(events[1]?.eventHash).toBe(
      'sha256:648e7c8c996361b12eb0f39857450cc0c91ed41d723d92edd387957f00eb2a9b'
    )
    expect(launched.context.contextHash).toBe(
      'sha256:ac54cd3d443081755f033b537af12d721c8b053ed681bea302f7845c751dce69'
    )
    expect(Object.keys(created.task.state)).toEqual(['status'])
    expect(Object.keys(events[0]?.payload['state'] as Record<string, unknown>)).toEqual(['status'])
    expect(Object.keys(launched.context.task.state)).toEqual(['status'])
  })
})
