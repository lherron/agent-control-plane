import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'

import { basicWorkflowV1 } from '../workflow/definitions.js'
import {
  type ActorRef,
  type WorkflowRejectionCode,
  type WorkflowResult,
  createInMemoryWorkflowKernel,
} from '../workflow/index.js'

const owner: ActorRef = { kind: 'agent', id: 'larry' }
const otherActor: ActorRef = { kind: 'agent', id: 'curly' }

function seededKernel() {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-09T12:00:00.000Z' })
  kernel.publishWorkflowDefinition(basicWorkflowV1)
  return kernel
}

function createTask(roleBindings: Record<string, ActorRef | null> = { owner }) {
  const kernel = seededKernel()
  const created = kernel.createTask({
    taskId: 'task-participant-runtime',
    projectId: 'agent-spaces',
    workflow: { id: 'basic', version: 1 },
    goal: 'exercise participant runtime',
    roleBindings,
    idempotencyKey: 'task:create:participant-runtime',
  })
  expect(created.ok).toBe(true)
  return { kernel, taskId: 'task-participant-runtime' }
}

function expectReject(
  result: WorkflowResult<object>,
  code: WorkflowRejectionCode,
  messageFragment: string
) {
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.code).toBe(code)
    expect(result.error.message).toContain(messageFragment)
  }
}

describe('workflow participant runtime kernel surface', () => {
  test('launches a participant run only for the actor persisted on the role binding', () => {
    const { kernel, taskId } = createTask()

    const launched = kernel.startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      harness: { kind: 'codex' },
      idempotencyKey: 'participant:start:owner',
    })

    expect(launched.ok).toBe(true)
    if (!launched.ok) {
      throw new Error(launched.error.message)
    }
    expect(launched.participantRun).toMatchObject({
      kind: 'participant',
      taskId,
      role: 'owner',
      actor: owner,
      status: 'launched',
      taskVersionAtStart: 0,
    })
    expect(launched.context).toMatchObject({
      task: { id: taskId, version: 0 },
      run: {
        id: launched.participantRun.runId,
        actor: owner,
        role: 'owner',
      },
    })
    const contextHash = launched.context['contextHash']
    assert.ok(typeof contextHash === 'string')
    expect(launched.participantRun.contextHash).toBe(contextHash)
    expect(kernel.listEvents(taskId).map((event) => event.type)).toEqual([
      'task.created',
      'participant_run.launched',
    ])
  })

  test('rejects an unbound role and a mismatched actor without self-claiming the role', () => {
    const unbound = createTask({ owner: null })
    expectReject(
      unbound.kernel.startParticipantRun({
        taskId: unbound.taskId,
        role: 'owner',
        actor: owner,
        idempotencyKey: 'participant:start:unbound',
      }),
      'role_not_bound',
      'is not bound'
    )

    const bound = createTask()
    expectReject(
      bound.kernel.startParticipantRun({
        taskId: bound.taskId,
        role: 'owner',
        actor: otherActor,
        idempotencyKey: 'participant:start:mismatch',
      }),
      'role_not_bound',
      'is bound to a different actor'
    )
    // The mismatched actor must not have claimed the role.
    expect(bound.kernel.getTask(bound.taskId)?.roleBindings['owner']).toEqual(owner)
  })

  test('idempotently resumes an existing run and recompiles ParticipantContext', () => {
    const { kernel, taskId } = createTask()
    const first = kernel.startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'participant:start:idempotent',
    })
    if (!first.ok) {
      throw new Error(first.error.message)
    }

    const replay = kernel.startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'participant:start:idempotent',
    })

    expect(replay).toEqual(first)

    const resumed = kernel.resumeParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
    })

    expect(resumed.ok).toBe(true)
    if (!resumed.ok) {
      throw new Error(resumed.error.message)
    }
    expect(resumed.participantRun.runId).toBe(first.participantRun.runId)
    expect(resumed.context).toMatchObject({
      task: { id: taskId, version: 0 },
      run: { id: first.participantRun.runId, actor: owner, role: 'owner' },
    })
  })

  test('records participant run completion and failure lifecycle events with outcomes', () => {
    const { kernel, taskId } = createTask()
    const launched = kernel.startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'participant:lifecycle:start',
    })

    if (!launched.ok) {
      throw new Error(launched.error.message)
    }

    const completed = kernel.completeParticipantRun(launched.participantRun.runId, {
      outcome: 'success',
      evidenceRefs: ['artifact://summary'],
      summary: 'owner finished',
      idempotencyKey: 'participant:lifecycle:complete',
    })
    expect(completed.ok).toBe(true)
    if (!completed.ok) {
      throw new Error(completed.error.message)
    }
    expect(completed.participantRun.status).toBe('completed')
    expect(kernel.listEvents(taskId).at(-1)).toMatchObject({
      type: 'participant_run.completed',
      participantRunId: launched.participantRun.runId,
      payload: { outcome: 'success', evidenceRefs: ['artifact://summary'] },
    })

    const failureRun = kernel.startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'participant:lifecycle:start-failure',
    })
    if (!failureRun.ok) {
      throw new Error(failureRun.error.message)
    }

    const failed = kernel.failParticipantRun(failureRun.participantRun.runId, {
      reason: 'tests failed',
      classification: 'participant_repeated_failure',
      idempotencyKey: 'participant:lifecycle:fail',
    })
    expect(failed.ok).toBe(true)
    if (!failed.ok) {
      throw new Error(failed.error.message)
    }
    expect(failed.participantRun.status).toBe('failed')
    expect(kernel.listEvents(taskId).at(-1)).toMatchObject({
      type: 'participant_run.completed',
      participantRunId: failureRun.participantRun.runId,
      payload: {
        outcome: 'failed',
        reason: 'tests failed',
        classification: 'participant_repeated_failure',
      },
    })
  })
})
