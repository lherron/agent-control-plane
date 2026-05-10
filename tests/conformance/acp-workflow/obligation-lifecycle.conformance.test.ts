import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  type WorkflowDefinition,
  type WorkflowRejectionCode,
  createInMemoryWorkflowKernel,
} from '../../../packages/acp-core/src/workflow/index.js'

const implementer: ActorRef = { kind: 'agent', id: 'larry' }
const reviewer: ActorRef = { kind: 'agent', id: 'curly' }
const supervisor: ActorRef = { kind: 'agent', id: 'coordinator' }

const conformanceWaiverWorkflow = {
  id: 'conformance_obligation_waiver',
  version: 1,
  kind: 'conformance',
  initial: { status: 'open', phase: 'work' },
  phases: {
    work: {},
    done: {},
  },
  outcomes: {
    success: {},
  },
  roles: {
    implementer: { binding: 'required' },
    reviewer: { binding: 'required' },
  },
  evidenceKinds: {},
  obligationKinds: {
    acceptance_override: {
      blockingDefault: false,
      ownerRoles: ['implementer'],
    },
  },
  transitions: {
    start: {
      id: 'start',
      from: { status: 'open', phase: 'work' },
      to: { status: 'active', phase: 'work' },
      by: ['implementer'],
    },
    accept_with_waiver: {
      id: 'accept_with_waiver',
      from: { status: 'active', phase: 'work' },
      to: { status: 'closed', outcome: 'success' },
      by: ['reviewer'],
      requires: [{ type: 'waiver', waiverKind: 'acceptance_override' }],
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

function seededKernel() {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-09T12:00:00.000Z' })
  kernel.publishWorkflowDefinition(conformanceWaiverWorkflow)
  const created = kernel.createTask({
    taskId: 'task-conformance-waiver',
    projectId: 'demo',
    workflow: { id: 'conformance_obligation_waiver', version: 1 },
    goal: 'Conformance waiverRefs behavior',
    roleBindings: { implementer, reviewer },
    supervisor: {
      actor: supervisor,
      autonomy: 'managed',
      capabilities: { createObligations: true, createWaivers: true },
    },
    idempotencyKey: 'conformance:create',
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
    idempotencyKey: 'conformance:start',
  })
  if (!started.ok) {
    throw new Error(started.error.message)
  }
  const obligation = kernel.submitControlAction({
    taskId: created.task.taskId,
    supervisorRunId: 'run-supervisor-conformance',
    expectedTaskVersion: 1,
    capabilities: { createObligations: true },
    action: {
      type: 'create_obligation',
      kind: 'acceptance_override',
      ownerRole: 'implementer',
      summary: 'Reviewer needs a recorded waiver before accepting',
      blocking: false,
    },
    idempotencyKey: 'conformance:obligation',
  })
  if (!obligation.ok || obligation.obligation === undefined) {
    throw new Error('obligation was not created')
  }
  return { kernel, obligationId: obligation.obligation.obligationId }
}

describe('ACP workflow obligation lifecycle conformance', () => {
  test('waiverRefs are honored for Requirement{type:"waiver"} transitions', () => {
    const missing = seededKernel()
    expectReject(
      missing.kernel.applyTransition({
        taskId: 'task-conformance-waiver',
        transitionId: 'accept_with_waiver',
        actor: reviewer,
        role: 'reviewer',
        expectedTaskVersion: 2,
        idempotencyKey: 'conformance:transition:missing-waiver',
      }),
      'waiver_required'
    )

    const present = seededKernel()
    const waived = present.kernel.waiveObligation(present.obligationId, {
      actor: supervisor,
      reason: 'Acceptance waiver granted by supervisor',
      evidenceRefs: ['artifact://waiver'],
      idempotencyKey: 'conformance:waive',
    })
    expect(waived.ok).toBe(true)

    const transitioned = present.kernel.applyTransition({
      taskId: 'task-conformance-waiver',
      transitionId: 'accept_with_waiver',
      actor: reviewer,
      role: 'reviewer',
      expectedTaskVersion: 3,
      waiverRefs: [present.obligationId],
      idempotencyKey: 'conformance:transition:with-waiver',
    })

    expect(transitioned.ok).toBe(true)
    if (transitioned.ok) {
      expect(transitioned.task.state).toEqual({
        status: 'closed',
        phase: 'work',
        outcome: 'success',
      })
    }
  })
})
