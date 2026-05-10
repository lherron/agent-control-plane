import { describe, expect, test } from 'bun:test'

import { basicWorkflowV1 } from '../workflow/definitions.js'
import {
  type ActorRef,
  type WorkflowRejectionCode,
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

function expectReject<T extends WorkflowRejectionCode>(
  result: { ok: true } | { ok: false; error: { code: WorkflowRejectionCode } },
  code: T
) {
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.code).toBe(code)
  }
}

describe('workflow participant runtime kernel surface', () => {
  test('launches a participant run only for the actor persisted on the role binding', () => {
    const { kernel, taskId } = createTask()

    const launched = (kernel as any).startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      harness: { kind: 'codex' },
      idempotencyKey: 'participant:start:owner',
    })

    expect(launched.ok).toBe(true)
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
    expect(launched.participantRun.contextHash).toBe(launched.context.contextHash)
    expect(kernel.listEvents(taskId).map((event) => event.type)).toEqual([
      'task.created',
      'participant_run.launched',
    ])
  })

  test('rejects an unbound role and a mismatched actor without self-claiming the role', () => {
    const unbound = createTask({ owner: null })
    expectReject(
      (unbound.kernel as any).startParticipantRun({
        taskId: unbound.taskId,
        role: 'owner',
        actor: owner,
        idempotencyKey: 'participant:start:unbound',
      }),
      'role_not_bound'
    )

    const bound = createTask()
    expectReject(
      (bound.kernel as any).startParticipantRun({
        taskId: bound.taskId,
        role: 'owner',
        actor: otherActor,
        idempotencyKey: 'participant:start:mismatch',
      }),
      'role_not_bound'
    )
  })

  test('idempotently resumes an existing run and recompiles ParticipantContext', () => {
    const { kernel, taskId } = createTask()
    const first = (kernel as any).startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'participant:start:idempotent',
    })
    const replay = (kernel as any).startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'participant:start:idempotent',
    })

    expect(replay).toEqual(first)

    const resumed = (kernel as any).resumeParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
    })

    expect(resumed.ok).toBe(true)
    expect(resumed.participantRun.runId).toBe(first.participantRun.runId)
    expect(resumed.context).toMatchObject({
      task: { id: taskId, version: 0 },
      run: { id: first.participantRun.runId, actor: owner, role: 'owner' },
    })
  })

  test('records participant run completion and failure lifecycle events with outcomes', () => {
    const { kernel, taskId } = createTask()
    const launched = (kernel as any).startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'participant:lifecycle:start',
    })

    const completed = (kernel as any).completeParticipantRun(launched.participantRun.runId, {
      outcome: 'success',
      evidenceRefs: ['artifact://summary'],
      summary: 'owner finished',
      idempotencyKey: 'participant:lifecycle:complete',
    })
    expect(completed.ok).toBe(true)
    expect(completed.participantRun.status).toBe('completed')
    expect(kernel.listEvents(taskId).at(-1)).toMatchObject({
      type: 'participant_run.completed',
      participantRunId: launched.participantRun.runId,
      payload: { outcome: 'success', evidenceRefs: ['artifact://summary'] },
    })

    const failureRun = (kernel as any).startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'participant:lifecycle:start-failure',
    })
    const failed = (kernel as any).failParticipantRun(failureRun.participantRun.runId, {
      reason: 'tests failed',
      classification: 'participant_repeated_failure',
      idempotencyKey: 'participant:lifecycle:fail',
    })
    expect(failed.ok).toBe(true)
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
