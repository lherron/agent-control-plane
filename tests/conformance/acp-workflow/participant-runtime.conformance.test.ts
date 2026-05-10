import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  type WorkflowRejectionCode,
  createInMemoryWorkflowKernel,
} from '../../../packages/acp-core/src/workflow/index.js'
import { basicWorkflowV1 } from './fixtures/workflows.js'

const owner: ActorRef = { kind: 'agent', id: 'larry' }
const intruder: ActorRef = { kind: 'agent', id: 'mallory' }

function seededKernel() {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-09T12:00:00.000Z' })
  kernel.publishWorkflowDefinition(basicWorkflowV1)
  return kernel
}

function createTask(roleBindings: Record<string, ActorRef | null> = { owner }) {
  const kernel = seededKernel()
  const created = kernel.createTask({
    taskId: 'task-participant-conformance',
    projectId: 'agent-spaces',
    workflow: { id: 'basic', version: 1 },
    goal: 'prove participant runtime conformance',
    roleBindings,
    idempotencyKey: 'conformance:participant:create',
  })
  expect(created.ok).toBe(true)
  return { kernel, taskId: 'task-participant-conformance' }
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

describe('ACP participant runtime conformance', () => {
  test('direct participant launch requires a persisted matching role binding', () => {
    const bound = createTask()
    const launched = (bound.kernel as any).startParticipantRun({
      taskId: bound.taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'conformance:participant:start',
    })

    expect(launched.ok).toBe(true)
    expect(launched.participantRun).toMatchObject({
      kind: 'participant',
      role: 'owner',
      actor: owner,
      status: 'launched',
    })
    expect(launched.context).toMatchObject({
      contextHash: launched.participantRun.contextHash,
      task: { id: bound.taskId },
      run: { id: launched.participantRun.runId, actor: owner, role: 'owner' },
    })

    const mismatched = createTask()
    expectReject(
      (mismatched.kernel as any).startParticipantRun({
        taskId: mismatched.taskId,
        role: 'owner',
        actor: intruder,
        idempotencyKey: 'conformance:participant:mismatch',
      }),
      'role_not_bound'
    )

    const unbound = createTask({ owner: null })
    expectReject(
      (unbound.kernel as any).startParticipantRun({
        taskId: unbound.taskId,
        role: 'owner',
        actor: owner,
        idempotencyKey: 'conformance:participant:unbound',
      }),
      'role_not_bound'
    )
  })

  test('resume returns the existing participant run and recompiles context for current task state', () => {
    const { kernel, taskId } = createTask()
    const launched = (kernel as any).startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'conformance:participant:resume:start',
    })

    const transition = kernel.applyTransition({
      taskId,
      transitionId: 'start',
      role: 'owner',
      actor: owner,
      expectedTaskVersion: 0,
      contextHash: launched.context.contextHash,
      idempotencyKey: 'conformance:participant:transition:start',
      runId: launched.participantRun.runId,
    })
    expect(transition.ok).toBe(true)

    const resumed = (kernel as any).resumeParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
    })

    expect(resumed.ok).toBe(true)
    expect(resumed.participantRun.runId).toBe(launched.participantRun.runId)
    expect(resumed.context).toMatchObject({
      task: { id: taskId, version: 1, state: { status: 'active', phase: 'doing' } },
      run: { id: launched.participantRun.runId, actor: owner, role: 'owner' },
    })
    expect(resumed.context.contextHash).not.toBe(launched.context.contextHash)
  })

  test('participant run lifecycle exposes launched, running, completed, failed, and cancelled statuses', () => {
    const { kernel, taskId } = createTask()
    const launched = (kernel as any).startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'conformance:participant:lifecycle:start',
    })
    expect(launched.participantRun.status).toBe('launched')

    const running = (kernel as any).markParticipantRunRunning(launched.participantRun.runId, {
      idempotencyKey: 'conformance:participant:lifecycle:running',
    })
    expect(running.ok).toBe(true)
    expect(running.participantRun.status).toBe('running')

    const completed = (kernel as any).completeParticipantRun(launched.participantRun.runId, {
      outcome: 'success',
      summary: 'completed conformance work',
      idempotencyKey: 'conformance:participant:lifecycle:complete',
    })
    expect(completed.ok).toBe(true)
    expect(completed.participantRun.status).toBe('completed')

    const failedRun = (kernel as any).startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'conformance:participant:lifecycle:start-failed',
    })
    const failed = (kernel as any).failParticipantRun(failedRun.participantRun.runId, {
      reason: 'runtime failed',
      classification: 'participant_repeated_failure',
      idempotencyKey: 'conformance:participant:lifecycle:fail',
    })
    expect(failed.ok).toBe(true)
    expect(failed.participantRun.status).toBe('failed')

    const cancelledRun = (kernel as any).startParticipantRun({
      taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'conformance:participant:lifecycle:start-cancelled',
    })
    const cancelled = (kernel as any).cancelParticipantRun(cancelledRun.participantRun.runId, {
      reason: 'operator cancelled',
      idempotencyKey: 'conformance:participant:lifecycle:cancel',
    })
    expect(cancelled.ok).toBe(true)
    expect(cancelled.participantRun.status).toBe('cancelled')

    expect(
      kernel.listEvents(taskId).filter((event) => event.type === 'participant_run.completed')
    ).toEqual([
      expect.objectContaining({
        participantRunId: launched.participantRun.runId,
        payload: expect.objectContaining({ outcome: 'success' }),
      }),
      expect.objectContaining({
        participantRunId: failedRun.participantRun.runId,
        payload: expect.objectContaining({
          outcome: 'failed',
          classification: 'participant_repeated_failure',
        }),
      }),
    ])
  })
})
