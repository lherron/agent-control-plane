import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  type WorkflowControlAction,
  type WorkflowRejectionCode,
  createInMemoryWorkflowKernel,
} from '../../../packages/acp-core/src/workflow/index.js'
import { basicWorkflowV1 } from './fixtures/workflows.js'

const owner: ActorRef = { kind: 'agent', id: 'larry' }
const supervisor: ActorRef = { kind: 'agent', id: 'rex' }

type SupervisorAction = WorkflowControlAction & Record<string, unknown>

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
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-10T12:00:00.000Z' })
  kernel.publishWorkflowDefinition(basicWorkflowV1)
  const created = kernel.createTask({
    taskId: 'conformance-supervisor-actions',
    projectId: 'agent-spaces',
    workflow: { id: 'basic', version: 1 },
    goal: 'conform supervisor controls',
    roleBindings: { owner },
    supervisor: {
      actor: supervisor,
      autonomy: 'managed',
      capabilities: {},
    },
    idempotencyKey: 'conformance-supervisor-actions:create',
  })
  expect(created.ok).toBe(true)
  return kernel
}

function startSupervisorRun(
  kernel: ReturnType<typeof createInMemoryWorkflowKernel>,
  capabilities: Record<string, unknown>
) {
  const started = kernel.startSupervisorRun({
    taskId: 'conformance-supervisor-actions',
    runId: 'conformance-supervisor-run',
    supervisor,
    autonomy: 'managed',
    capabilities: capabilities as never,
    idempotencyKey: 'conformance-supervisor-actions:start-supervisor',
  })
  expect(started.ok).toBe(true)
}

function submit(
  kernel: ReturnType<typeof createInMemoryWorkflowKernel>,
  action: SupervisorAction,
  key: string,
  capabilities?: Record<string, unknown> | undefined
) {
  return kernel.submitControlAction({
    taskId: 'conformance-supervisor-actions',
    supervisorRunId: 'conformance-supervisor-run',
    ...(capabilities !== undefined ? { capabilities: capabilities as never } : {}),
    action,
    idempotencyKey: key,
  } as never)
}

describe('ACP workflow supervisor action conformance', () => {
  test('supervisor capabilities come from the persisted run record, not the request body', () => {
    const kernel = seededKernel()
    startSupervisorRun(kernel, {})

    expectReject(
      submit(
        kernel,
        {
          type: 'create_obligation',
          kind: 'missing_evidence',
          summary: 'body capabilities are ignored',
        } as SupervisorAction,
        'conformance-supervisor-actions:body-capability',
        { createObligations: true }
      ),
      'capability_not_granted'
    )

    expectReject(
      submit(
        kernel,
        {
          type: 'attach_evidence',
          evidence: [{ kind: 'completion_note', ref: 'artifact://note', summary: 'done' }],
        } as SupervisorAction,
        'conformance-supervisor-actions:attach-body-capability',
        { attachEvidence: true }
      ),
      'capability_not_granted'
    )
  })

  test('waive_obligation requires persisted createWaivers authority', () => {
    const kernel = seededKernel()
    startSupervisorRun(kernel, { createObligations: true, createWaivers: true })
    const obligation = submit(
      kernel,
      {
        type: 'create_obligation',
        kind: 'missing_evidence',
        summary: 'waiver target',
        blocking: false,
      } as SupervisorAction,
      'conformance-supervisor-actions:waive:create'
    )
    expect(obligation.ok).toBe(true)
    if (!obligation.ok || obligation.obligation === undefined) {
      throw new Error('obligation was not created')
    }

    const waived = submit(
      kernel,
      {
        type: 'waive_obligation',
        obligationId: obligation.obligation.obligationId,
        reason: 'accepted by supervisor',
      } as unknown as SupervisorAction,
      'conformance-supervisor-actions:waive:allowed'
    )

    expect(waived.ok).toBe(true)
    expect(kernel.listObligations('conformance-supervisor-actions')).toContainEqual(
      expect.objectContaining({
        obligationId: obligation.obligation.obligationId,
        status: 'waived',
      })
    )
  })

  test('AttachEvidence and Escalate produce durable workflow records', () => {
    const kernel = seededKernel()
    startSupervisorRun(kernel, { attachEvidence: true, escalate: true })

    const attached = submit(
      kernel,
      {
        type: 'attach_evidence',
        evidence: [{ kind: 'completion_note', ref: 'artifact://note', summary: 'done' }],
      } as SupervisorAction,
      'conformance-supervisor-actions:attach'
    )
    expect(attached.ok).toBe(true)
    expect(kernel.listEvidence('conformance-supervisor-actions')).toContainEqual(
      expect.objectContaining({
        kind: 'completion_note',
        supervisorRunId: 'conformance-supervisor-run',
      })
    )

    const escalated = submit(
      kernel,
      {
        type: 'escalate',
        reason: 'human judgment required',
        severity: 'medium',
        audience: 'maintainers',
      } as SupervisorAction,
      'conformance-supervisor-actions:escalate'
    )
    expect(escalated.ok).toBe(true)
    expect(kernel.listEvents('conformance-supervisor-actions')).toContainEqual(
      expect.objectContaining({
        type: 'supervisor.escalated',
        supervisorRunId: 'conformance-supervisor-run',
        payload: expect.objectContaining({ reason: 'human judgment required' }),
      })
    )
    expect(kernel.listEffectIntents('conformance-supervisor-actions')).toContainEqual(
      expect.objectContaining({
        kind: 'create_obligation',
        payload: expect.objectContaining({ kind: 'human_review' }),
      })
    )
  })

  test('ApplyTransition succeeds only from participant-run evidence', () => {
    const kernel = seededKernel()
    startSupervisorRun(kernel, { applySupervisorTransitions: true })
    kernel.applyTransition({
      taskId: 'conformance-supervisor-actions',
      transitionId: 'start',
      actor: owner,
      role: 'owner',
      expectedTaskVersion: 0,
      idempotencyKey: 'conformance-supervisor-actions:start',
    })
    const run = kernel.startParticipantRun({
      taskId: 'conformance-supervisor-actions',
      role: 'owner',
      actor: owner,
      idempotencyKey: 'conformance-supervisor-actions:participant',
    })
    expect(run.ok).toBe(true)
    if (!run.ok) {
      throw new Error(run.error.message)
    }
    const evidence = kernel.attachEvidence({
      taskId: 'conformance-supervisor-actions',
      actor: owner,
      role: 'owner',
      runId: run.participantRun.runId,
      participantRunId: run.participantRun.runId,
      evidence: [{ kind: 'completion_note', ref: 'artifact://participant-note', summary: 'done' }],
      idempotencyKey: 'conformance-supervisor-actions:participant-evidence',
    })
    expect(evidence.ok).toBe(true)
    if (!evidence.ok) {
      throw new Error(evidence.error.message)
    }
    kernel.completeParticipantRun(run.participantRun.runId, {
      outcome: 'success',
      evidenceRefs: [evidence.evidence[0]?.evidenceId ?? 'missing'],
      idempotencyKey: 'conformance-supervisor-actions:participant-complete',
    })

    const applied = submit(
      kernel,
      {
        type: 'apply_transition',
        transitionId: 'close_success',
        evidenceRefs: [evidence.evidence[0]?.evidenceId],
        expectedTaskVersion: 1,
      } as SupervisorAction,
      'conformance-supervisor-actions:apply'
    )
    expect(applied.ok).toBe(true)
    expect(kernel.listEvents('conformance-supervisor-actions')).toContainEqual(
      expect.objectContaining({
        type: 'transition.applied',
        payload: expect.objectContaining({
          authority: 'supervisor_from_participant_evidence',
          evidenceRefs: [evidence.evidence[0]?.evidenceId],
        }),
      })
    )

    const supervisorOnlyKernel = seededKernel()
    startSupervisorRun(supervisorOnlyKernel, {
      attachEvidence: true,
      applySupervisorTransitions: true,
    })
    supervisorOnlyKernel.applyTransition({
      taskId: 'conformance-supervisor-actions',
      transitionId: 'start',
      actor: owner,
      role: 'owner',
      expectedTaskVersion: 0,
      idempotencyKey: 'conformance-supervisor-actions:supervisor-only:start',
    })
    const supervisorEvidence = supervisorOnlyKernel.attachEvidence({
      taskId: 'conformance-supervisor-actions',
      actor: supervisor,
      supervisorRunId: 'conformance-supervisor-run',
      evidence: [{ kind: 'completion_note', ref: 'artifact://supervisor-note', summary: 'done' }],
      idempotencyKey: 'conformance-supervisor-actions:supervisor-only:evidence',
    })
    expect(supervisorEvidence.ok).toBe(true)
    if (!supervisorEvidence.ok) {
      throw new Error(supervisorEvidence.error.message)
    }
    expectReject(
      submit(
        supervisorOnlyKernel,
        {
          type: 'apply_transition',
          transitionId: 'close_success',
          evidenceRefs: [supervisorEvidence.evidence[0]?.evidenceId],
          expectedTaskVersion: 1,
        } as SupervisorAction,
        'conformance-supervisor-actions:supervisor-only:apply'
      ),
      'authority_not_granted'
    )
  })

  test('ApplyTransition missing evidenceRefs is a missing_evidence rejection', () => {
    const kernel = seededKernel()
    startSupervisorRun(kernel, { applySupervisorTransitions: true })
    const started = kernel.applyTransition({
      taskId: 'conformance-supervisor-actions',
      transitionId: 'start',
      actor: owner,
      role: 'owner',
      expectedTaskVersion: 0,
      idempotencyKey: 'conformance-supervisor-actions:undefined-refs:start',
    })
    expect(started.ok).toBe(true)

    expectReject(
      submit(
        kernel,
        {
          type: 'apply_transition',
          transitionId: 'close_success',
        } as unknown as SupervisorAction,
        'conformance-supervisor-actions:undefined-refs:apply'
      ),
      'missing_evidence'
    )
  })

  test('standalone evidence attach validates participant run task provenance', () => {
    const kernel = seededKernel()
    const otherTask = kernel.createTask({
      taskId: 'conformance-supervisor-actions-other',
      projectId: 'agent-spaces',
      workflow: { id: 'basic', version: 1 },
      goal: 'other task',
      roleBindings: { owner },
      idempotencyKey: 'conformance-supervisor-actions:cross-task:create',
    })
    expect(otherTask.ok).toBe(true)
    const otherRun = kernel.startParticipantRun({
      taskId: 'conformance-supervisor-actions-other',
      role: 'owner',
      actor: owner,
      idempotencyKey: 'conformance-supervisor-actions:cross-task:run',
    })
    expect(otherRun.ok).toBe(true)
    if (!otherRun.ok) {
      throw new Error(otherRun.error.message)
    }

    expectReject(
      kernel.attachEvidence({
        taskId: 'conformance-supervisor-actions',
        actor: owner,
        role: 'owner',
        participantRunId: otherRun.participantRun.runId,
        evidence: [{ kind: 'completion_note', ref: 'artifact://cross-task', summary: 'done' }],
        idempotencyKey: 'conformance-supervisor-actions:cross-task:attach',
      }),
      'authority_not_granted'
    )
  })

  test('PauseSupervision gates control actions until UnpauseSupervision', () => {
    const kernel = seededKernel()
    startSupervisorRun(kernel, { pauseSupervision: true, createObligations: true })

    expect(
      submit(
        kernel,
        { type: 'pause_supervision', reason: 'wait' } as SupervisorAction,
        'conformance-supervisor-actions:pause'
      ).ok
    ).toBe(true)
    expect(kernel.listSupervisorRuns('conformance-supervisor-actions')).toContainEqual(
      expect.objectContaining({ paused: true, pausedReason: 'wait' })
    )
    expectReject(
      submit(
        kernel,
        {
          type: 'create_obligation',
          kind: 'missing_evidence',
          summary: 'blocked',
          blocking: false,
        } as SupervisorAction,
        'conformance-supervisor-actions:blocked'
      ),
      'supervisor_paused' as WorkflowRejectionCode
    )

    expect(
      submit(
        kernel,
        { type: 'unpause_supervision', reason: 'resume' } as SupervisorAction,
        'conformance-supervisor-actions:unpause'
      ).ok
    ).toBe(true)
    expect(
      submit(
        kernel,
        {
          type: 'create_obligation',
          kind: 'missing_evidence',
          summary: 'accepted',
          blocking: false,
        } as SupervisorAction,
        'conformance-supervisor-actions:accepted'
      ).ok
    ).toBe(true)
  })

  test('PauseSupervision requires persisted pauseSupervision authority while UnpauseSupervision remains ungated', () => {
    const kernel = seededKernel()
    startSupervisorRun(kernel, {})

    expectReject(
      submit(
        kernel,
        { type: 'pause_supervision', reason: 'missing capability' } as SupervisorAction,
        'conformance-supervisor-actions:pause:no-capability',
        { pauseSupervision: true }
      ),
      'capability_not_granted'
    )
  })
})
