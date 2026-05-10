import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  type ObligationRecord,
  type WorkflowDefinition,
  type WorkflowRejectionCode,
  createInMemoryWorkflowKernel,
} from '../workflow/index.js'

const implementer: ActorRef = { kind: 'agent', id: 'larry' }
const tester: ActorRef = { kind: 'agent', id: 'curly' }
const supervisor: ActorRef = { kind: 'agent', id: 'coordinator' }
const unauthorized: ActorRef = { kind: 'agent', id: 'intruder' }

const _reservedExpiredStatus: ObligationRecord['status'] = 'expired'

const waiverWorkflowV1 = {
  id: 'waiver_lifecycle',
  version: 1,
  kind: 'acceptance',
  initial: { status: 'open', phase: 'draft' },
  phases: {
    draft: {},
    review: {},
  },
  outcomes: {
    success: {},
    cancelled: {},
  },
  roles: {
    implementer: { binding: 'required' },
    tester: { binding: 'required' },
  },
  evidenceKinds: {
    review_note: { requiredFields: ['ref'] },
  },
  obligationKinds: {
    evidence_override: {
      blockingDefault: false,
      ownerRoles: ['implementer'],
      allowedSatisfactionEvidence: ['review_note'],
    },
  },
  transitions: {
    start: {
      id: 'start',
      from: { status: 'open', phase: 'draft' },
      to: { status: 'active', phase: 'review' },
      by: ['implementer'],
    },
    close_with_waiver: {
      id: 'close_with_waiver',
      from: { status: 'active', phase: 'review' },
      to: { status: 'closed', outcome: 'success' },
      by: ['tester'],
      requires: [{ type: 'waiver', waiverKind: 'evidence_override' }],
    },
  },
} satisfies WorkflowDefinition

function expectReject<T extends WorkflowRejectionCode>(
  result: { ok: true } | { ok: false; error: { code: WorkflowRejectionCode } },
  code: T
) {
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.code).toBe(code)
  }
}

function createActiveTask() {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-09T12:00:00.000Z' })
  kernel.publishWorkflowDefinition(waiverWorkflowV1)
  const created = kernel.createTask({
    taskId: 'task-waiver-1',
    projectId: 'demo',
    workflow: { id: 'waiver_lifecycle', version: 1 },
    goal: 'Validate obligation waiver semantics',
    roleBindings: { implementer, tester },
    supervisor: {
      actor: supervisor,
      autonomy: 'managed',
      capabilities: {
        createObligations: true,
        createWaivers: true,
      },
    },
    idempotencyKey: 'task:create:waiver-1',
  })
  if (!created.ok) {
    throw new Error(created.error.message)
  }
  const started = kernel.applyTransition({
    taskId: created.task.taskId,
    transitionId: 'start',
    actor: implementer,
    role: 'implementer',
    expectedTaskVersion: 0,
    idempotencyKey: 'task:start:waiver-1',
  })
  if (!started.ok) {
    throw new Error(started.error.message)
  }
  return { kernel, task: started.task }
}

function createWaiverObligation() {
  const { kernel, task } = createActiveTask()
  const created = kernel.submitControlAction({
    taskId: task.taskId,
    supervisorRunId: 'run-supervisor-waiver',
    expectedTaskVersion: task.version,
    capabilities: { createObligations: true },
    action: {
      type: 'create_obligation',
      kind: 'evidence_override',
      ownerRole: 'implementer',
      summary: 'Need explicit waiver for missing review evidence',
      blocking: false,
    },
    idempotencyKey: 'obligation:create:evidence-override',
  })
  expect(created.ok).toBe(true)
  if (!created.ok || created.obligation === undefined) {
    throw new Error('obligation was not created')
  }
  return { kernel, taskId: task.taskId, obligationId: created.obligation.obligationId }
}

describe('ACP workflow obligation waive/cancel lifecycle', () => {
  test('waives an obligation with reason and evidence refs, recording waiver and obligation events', () => {
    const { kernel, taskId, obligationId } = createWaiverObligation()

    const waived = kernel.waiveObligation(obligationId, {
      actor: supervisor,
      reason: 'Human accepted the missing evidence risk',
      evidenceRefs: ['artifact://approval-note'],
      idempotencyKey: 'obligation:waive:evidence-override',
    })

    expect(waived.ok).toBe(true)
    if (waived.ok) {
      expect(waived.obligation).toMatchObject({
        obligationId,
        status: 'waived',
        waivedAt: '2026-05-09T12:00:00.000Z',
        waiverReason: 'Human accepted the missing evidence risk',
        waiverEvidenceRefs: ['artifact://approval-note'],
      })
    }
    expect(kernel.listObligations(taskId)[0]).toMatchObject({
      obligationId,
      status: 'waived',
      waiverEvidenceRefs: ['artifact://approval-note'],
    })
    expect(kernel.listEvents(taskId).map((event) => event.type)).toContain('waiver.recorded')
    expect(kernel.listEvents(taskId).map((event) => event.type)).toContain('obligation.waived')
  })

  test('waive obligation is idempotent for the same idempotency key', () => {
    const { kernel, obligationId } = createWaiverObligation()
    const request = {
      actor: supervisor,
      reason: 'Repeatable supervisor waiver',
      evidenceRefs: ['artifact://waiver-record'],
      idempotencyKey: 'obligation:waive:idempotent',
    }

    const first = kernel.waiveObligation(obligationId, request)
    const second = kernel.waiveObligation(obligationId, request)

    expect(first).toEqual(second)
    expect(first.ok).toBe(true)
  })

  test('cancels an obligation with a reason without satisfying waiver requirements', () => {
    const { kernel, taskId, obligationId } = createWaiverObligation()

    const cancelled = kernel.cancelObligation(obligationId, {
      actor: supervisor,
      reason: 'Superseded by a different work path',
      idempotencyKey: 'obligation:cancel:evidence-override',
    })

    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) {
      expect(cancelled.obligation).toMatchObject({
        obligationId,
        status: 'cancelled',
        cancelledAt: '2026-05-09T12:00:00.000Z',
        cancelReason: 'Superseded by a different work path',
      })
    }
    expect(kernel.listEvents(taskId).map((event) => event.type)).toContain('obligation.cancelled')
    expectReject(
      kernel.applyTransition({
        taskId,
        transitionId: 'close_with_waiver',
        actor: tester,
        role: 'tester',
        expectedTaskVersion: 3,
        waiverRefs: [obligationId],
        idempotencyKey: 'transition:cancelled-waiver-ref',
      }),
      'waiver_required'
    )
  })

  test('transition requiring waiver succeeds only when waiverRefs point at a persisted waiver', () => {
    const missing = createWaiverObligation()
    expectReject(
      missing.kernel.applyTransition({
        taskId: missing.taskId,
        transitionId: 'close_with_waiver',
        actor: tester,
        role: 'tester',
        expectedTaskVersion: 2,
        idempotencyKey: 'transition:missing-waiver-ref',
      }),
      'waiver_required'
    )

    const present = createWaiverObligation()
    const waived = present.kernel.waiveObligation(present.obligationId, {
      actor: supervisor,
      reason: 'Waiver is explicitly recorded before transition',
      evidenceRefs: ['artifact://waiver'],
      idempotencyKey: 'obligation:waive:for-transition',
    })
    expect(waived.ok).toBe(true)

    const transitioned = present.kernel.applyTransition({
      taskId: present.taskId,
      transitionId: 'close_with_waiver',
      actor: tester,
      role: 'tester',
      expectedTaskVersion: 3,
      waiverRefs: [present.obligationId],
      idempotencyKey: 'transition:waiver-ref-present',
    })

    expect(transitioned.ok).toBe(true)
    if (transitioned.ok) {
      expect(transitioned.event.payload).toMatchObject({
        transitionId: 'close_with_waiver',
        waiverRefs: [present.obligationId],
      })
      expect(transitioned.task.state).toEqual({
        status: 'closed',
        phase: 'review',
        outcome: 'success',
      })
    }
  })

  test('actor without obligation authority cannot waive or cancel', () => {
    const waiveCase = createWaiverObligation()
    expectReject(
      waiveCase.kernel.waiveObligation(waiveCase.obligationId, {
        actor: unauthorized,
        reason: 'No authority',
        idempotencyKey: 'obligation:waive:unauthorized',
      }),
      'authority_not_granted'
    )

    const cancelCase = createWaiverObligation()
    expectReject(
      cancelCase.kernel.cancelObligation(cancelCase.obligationId, {
        actor: unauthorized,
        reason: 'No authority',
        idempotencyKey: 'obligation:cancel:unauthorized',
      }),
      'authority_not_granted'
    )
  })
})
