import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  type WorkflowControlAction,
  type WorkflowRejectionCode,
  basicWorkflowV1,
  createInMemoryWorkflowKernel,
} from '../index.js'

const owner: ActorRef = { kind: 'agent', id: 'larry' }
const supervisor: ActorRef = { kind: 'agent', id: 'rex' }
const otherSupervisor: ActorRef = { kind: 'agent', id: 'clod' }

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

function createKernel() {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-10T12:00:00.000Z' })
  kernel.publishWorkflowDefinition(basicWorkflowV1)
  const created = kernel.createTask({
    taskId: 'task-supervisor-actions',
    projectId: 'agent-spaces',
    workflow: { id: 'basic', version: 1 },
    goal: 'prove supervisor controls',
    roleBindings: { owner },
    supervisor: {
      actor: supervisor,
      autonomy: 'managed',
      capabilities: {},
    },
    idempotencyKey: 'supervisor-actions:create',
  })
  if (!created.ok) {
    throw new Error(created.error.message)
  }
  return { kernel, task: created.task }
}

function startSupervisorRun(
  kernel: ReturnType<typeof createInMemoryWorkflowKernel>,
  capabilities: Record<string, unknown> | undefined,
  runId = 'supervisor-run-1',
  actor = supervisor,
  taskId = 'task-supervisor-actions'
) {
  const started = kernel.startSupervisorRun({
    taskId,
    runId,
    supervisor: actor,
    autonomy: 'managed',
    capabilities: capabilities as never,
    idempotencyKey: `supervisor-actions:start:${runId}`,
  })
  if (!started.ok) {
    throw new Error(started.error.message)
  }
  return started.supervisorRun
}

function submit(
  kernel: ReturnType<typeof createInMemoryWorkflowKernel>,
  action: SupervisorAction,
  options: {
    runId?: string | undefined
    taskId?: string | undefined
    expectedTaskVersion?: number | undefined
    capabilities?: Record<string, unknown> | undefined
    actor?: ActorRef | undefined
    key?: string | undefined
  } = {}
) {
  return kernel.submitControlAction({
    taskId: options.taskId ?? 'task-supervisor-actions',
    supervisorRunId: options.runId ?? 'supervisor-run-1',
    ...(options.expectedTaskVersion !== undefined
      ? { expectedTaskVersion: options.expectedTaskVersion }
      : {}),
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities as never } : {}),
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
    action,
    idempotencyKey: options.key ?? `supervisor-actions:${action.type}:${Math.random()}`,
  } as never)
}

describe('workflow supervisor control actions', () => {
  test('AttachEvidence is capability gated by the persisted supervisor run and records supervisor provenance', () => {
    const { kernel } = createKernel()
    startSupervisorRun(kernel, {})

    expectReject(
      submit(
        kernel,
        {
          type: 'attach_evidence',
          evidence: [{ kind: 'completion_note', ref: 'artifact://note', summary: 'done' }],
        } as SupervisorAction,
        {
          capabilities: { attachEvidence: true },
          key: 'supervisor-actions:attach:denied',
        }
      ),
      'capability_not_granted'
    )

    startSupervisorRun(kernel, { attachEvidence: true }, 'supervisor-run-attach')
    const attached = submit(
      kernel,
      {
        type: 'attach_evidence',
        evidence: [{ kind: 'completion_note', ref: 'artifact://note', summary: 'done' }],
      } as SupervisorAction,
      { runId: 'supervisor-run-attach', key: 'supervisor-actions:attach:allowed' }
    )

    expect(attached.ok).toBe(true)
    expect(kernel.listEvidence('task-supervisor-actions')).toEqual([
      expect.objectContaining({
        kind: 'completion_note',
        ref: 'artifact://note',
        actor: supervisor,
        supervisorRunId: 'supervisor-run-attach',
      }),
    ])
    expect(kernel.listEvents('task-supervisor-actions')).toContainEqual(
      expect.objectContaining({
        type: 'evidence.attached',
        supervisorRunId: 'supervisor-run-attach',
        payload: expect.objectContaining({ supervisorRunId: 'supervisor-run-attach' }),
      })
    )
  })

  test('AttachEvidence fails closed when the persisted run capabilities are missing', () => {
    const { kernel } = createKernel()
    startSupervisorRun(kernel, undefined, 'supervisor-run-attach-undefined')

    expectReject(
      submit(
        kernel,
        {
          type: 'attach_evidence',
          evidence: [{ kind: 'completion_note', ref: 'artifact://note', summary: 'done' }],
        } as SupervisorAction,
        {
          runId: 'supervisor-run-attach-undefined',
          capabilities: { attachEvidence: true },
          key: 'supervisor-actions:attach:undefined-capabilities',
        }
      ),
      'capability_not_granted'
    )
  })

  test('WaiveObligation action is capability gated by persisted createWaivers', () => {
    const { kernel, task } = createKernel()
    startSupervisorRun(kernel, { createObligations: true })
    const obligation = submit(
      kernel,
      {
        type: 'create_obligation',
        kind: 'missing_evidence',
        summary: 'waiver target',
        blocking: false,
      } as SupervisorAction,
      { expectedTaskVersion: task.version, key: 'supervisor-actions:waive:create' }
    )
    expect(obligation.ok).toBe(true)
    if (!obligation.ok || obligation.obligation === undefined) {
      throw new Error('obligation was not created')
    }

    expectReject(
      submit(
        kernel,
        {
          type: 'waive_obligation',
          obligationId: obligation.obligation.obligationId,
          reason: 'request-body capabilities must not grant waiver authority',
        } as unknown as SupervisorAction,
        {
          capabilities: { createWaivers: true },
          key: 'supervisor-actions:waive:denied',
        }
      ),
      'capability_not_granted'
    )

    startSupervisorRun(
      kernel,
      { createObligations: true, createWaivers: true },
      'supervisor-run-waive'
    )
    const waived = submit(
      kernel,
      {
        type: 'waive_obligation',
        obligationId: obligation.obligation.obligationId,
        reason: 'supervisor accepted the risk',
        evidenceRefs: ['artifact://waiver'],
      } as unknown as SupervisorAction,
      {
        runId: 'supervisor-run-waive',
        key: 'supervisor-actions:waive:allowed',
      }
    )

    expect(waived.ok).toBe(true)
    expect(kernel.listObligations(task.taskId)).toContainEqual(
      expect.objectContaining({
        obligationId: obligation.obligation.obligationId,
        status: 'waived',
        waiverReason: 'supervisor accepted the risk',
        waiverEvidenceRefs: ['artifact://waiver'],
      })
    )
  })

  test('ApplyTransition uses participant-run evidence instead of supervisor role bypass', () => {
    const { kernel, task } = createKernel()
    startSupervisorRun(kernel, { applySupervisorTransitions: true })

    const started = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: owner,
      role: 'owner',
      expectedTaskVersion: 0,
      idempotencyKey: 'supervisor-actions:participant:start',
    })
    expect(started.ok).toBe(true)

    const run = kernel.startParticipantRun({
      taskId: task.taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'supervisor-actions:participant-run:start',
    })
    expect(run.ok).toBe(true)
    if (!run.ok) {
      throw new Error(run.error.message)
    }

    const evidence = kernel.attachEvidence({
      taskId: task.taskId,
      actor: owner,
      role: 'owner',
      runId: run.participantRun.runId,
      participantRunId: run.participantRun.runId,
      evidence: [{ kind: 'completion_note', ref: 'artifact://participant-note', summary: 'done' }],
      idempotencyKey: 'supervisor-actions:participant:evidence',
    })
    expect(evidence.ok).toBe(true)
    if (!evidence.ok) {
      throw new Error(evidence.error.message)
    }
    kernel.completeParticipantRun(run.participantRun.runId, {
      outcome: 'success',
      evidenceRefs: [evidence.evidence[0]?.evidenceId ?? 'missing'],
      idempotencyKey: 'supervisor-actions:participant:complete',
    })

    const applied = submit(
      kernel,
      {
        type: 'apply_transition',
        transitionId: 'close_success',
        evidenceRefs: [evidence.evidence[0]?.evidenceId],
        expectedTaskVersion: 1,
      } as SupervisorAction,
      { expectedTaskVersion: 1, key: 'supervisor-actions:apply:participant-evidence' }
    )

    expect(applied.ok).toBe(true)
    expect(kernel.getTask(task.taskId)?.state).toMatchObject({
      status: 'closed',
      outcome: 'success',
    })
    expect(kernel.listEvents(task.taskId)).toContainEqual(
      expect.objectContaining({
        type: 'transition.applied',
        supervisorRunId: 'supervisor-run-1',
        payload: expect.objectContaining({
          authority: 'supervisor_from_participant_evidence',
          transitionId: 'close_success',
          role: 'owner',
          evidenceRefs: [evidence.evidence[0]?.evidenceId],
          supervisorRunId: 'supervisor-run-1',
        }),
      })
    )
  })

  test('ApplyTransition rejects missing capability, missing refs, supervisor-only evidence, mismatched actor, and disallowed roles', () => {
    const { kernel, task } = createKernel()
    startSupervisorRun(kernel, {})

    expectReject(
      submit(
        kernel,
        {
          type: 'apply_transition',
          transitionId: 'close_success',
          evidenceRefs: [],
        } as SupervisorAction,
        {
          capabilities: { applySupervisorTransitions: true },
          key: 'supervisor-actions:apply:no-capability',
        }
      ),
      'capability_not_granted'
    )

    startSupervisorRun(kernel, { applySupervisorTransitions: true }, 'supervisor-run-apply')
    kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: owner,
      role: 'owner',
      expectedTaskVersion: 0,
      idempotencyKey: 'supervisor-actions:apply:start',
    })
    const supervisorEvidence = kernel.attachEvidence({
      taskId: task.taskId,
      actor: supervisor,
      supervisorRunId: 'supervisor-run-apply',
      evidence: [{ kind: 'completion_note', ref: 'artifact://supervisor-note', summary: 'done' }],
      idempotencyKey: 'supervisor-actions:apply:supervisor-evidence',
    })
    expect(supervisorEvidence.ok).toBe(true)
    if (!supervisorEvidence.ok) {
      throw new Error(supervisorEvidence.error.message)
    }

    expectReject(
      submit(
        kernel,
        {
          type: 'apply_transition',
          transitionId: 'close_success',
          evidenceRefs: [],
        } as SupervisorAction,
        {
          runId: 'supervisor-run-apply',
          expectedTaskVersion: 1,
          key: 'supervisor-actions:apply:missing-refs',
        }
      ),
      'missing_evidence'
    )
    expectReject(
      submit(
        kernel,
        {
          type: 'apply_transition',
          transitionId: 'close_success',
          evidenceRefs: [supervisorEvidence.evidence[0]?.evidenceId],
        } as SupervisorAction,
        {
          runId: 'supervisor-run-apply',
          expectedTaskVersion: 1,
          key: 'supervisor-actions:apply:supervisor-only',
        }
      ),
      'authority_not_granted'
    )

    const mismatchedRun = kernel.startParticipantRun({
      taskId: task.taskId,
      role: 'owner',
      actor: owner,
      idempotencyKey: 'supervisor-actions:apply:mismatch-run',
    })
    expect(mismatchedRun.ok).toBe(true)
    if (!mismatchedRun.ok) {
      throw new Error(mismatchedRun.error.message)
    }
    const mismatchEvidence = kernel.attachEvidence({
      taskId: task.taskId,
      actor: owner,
      role: 'owner',
      runId: mismatchedRun.participantRun.runId,
      participantRunId: mismatchedRun.participantRun.runId,
      evidence: [{ kind: 'completion_note', ref: 'artifact://mismatch', summary: 'done' }],
      idempotencyKey: 'supervisor-actions:apply:mismatch-evidence',
    })
    expect(mismatchEvidence.ok).toBe(true)
    if (!mismatchEvidence.ok) {
      throw new Error(mismatchEvidence.error.message)
    }
    const mismatchedSnapshot = kernel.exportSnapshot()
    const mismatchedTask = mismatchedSnapshot.tasks.find((item) => item.taskId === task.taskId)
    if (mismatchedTask === undefined) {
      throw new Error('task missing from exported snapshot')
    }
    mismatchedTask.roleBindings['owner'] = otherSupervisor
    const mismatchedKernel = createInMemoryWorkflowKernel({ snapshot: mismatchedSnapshot })

    expectReject(
      submit(
        mismatchedKernel,
        {
          type: 'apply_transition',
          transitionId: 'close_success',
          evidenceRefs: [mismatchEvidence.evidence[0]?.evidenceId],
        } as SupervisorAction,
        {
          runId: 'supervisor-run-apply',
          expectedTaskVersion: 1,
          key: 'supervisor-actions:apply:mismatch',
        }
      ),
      'authority_not_granted'
    )

    expectReject(
      submit(
        kernel,
        {
          type: 'apply_transition',
          transitionId: 'close_success',
          role: 'supervisor',
          evidenceRefs: [mismatchEvidence.evidence[0]?.evidenceId],
        } as SupervisorAction,
        {
          runId: 'supervisor-run-apply',
          expectedTaskVersion: 1,
          key: 'supervisor-actions:apply:bad-role',
        }
      ),
      'role_not_allowed'
    )
  })

  test('ApplyTransition treats missing evidenceRefs as missing evidence instead of an internal error', () => {
    const { kernel, task } = createKernel()
    startSupervisorRun(kernel, { applySupervisorTransitions: true })
    const started = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: owner,
      role: 'owner',
      expectedTaskVersion: 0,
      idempotencyKey: 'supervisor-actions:apply:undefined-refs:start',
    })
    expect(started.ok).toBe(true)

    expectReject(
      submit(
        kernel,
        {
          type: 'apply_transition',
          transitionId: 'close_success',
        } as unknown as SupervisorAction,
        {
          expectedTaskVersion: 1,
          key: 'supervisor-actions:apply:undefined-refs',
        }
      ),
      'missing_evidence'
    )
  })

  test('standalone AttachEvidence rejects participant runs from another task', () => {
    const { kernel, task } = createKernel()
    const otherTask = kernel.createTask({
      taskId: 'task-supervisor-actions-other',
      projectId: 'agent-spaces',
      workflow: { id: 'basic', version: 1 },
      goal: 'other task',
      roleBindings: { owner },
      idempotencyKey: 'supervisor-actions:evidence-provenance:create-other',
    })
    expect(otherTask.ok).toBe(true)
    const otherRun = kernel.startParticipantRun({
      taskId: 'task-supervisor-actions-other',
      role: 'owner',
      actor: owner,
      idempotencyKey: 'supervisor-actions:evidence-provenance:other-run',
    })
    expect(otherRun.ok).toBe(true)
    if (!otherRun.ok) {
      throw new Error(otherRun.error.message)
    }

    expectReject(
      kernel.attachEvidence({
        taskId: task.taskId,
        actor: owner,
        role: 'owner',
        participantRunId: otherRun.participantRun.runId,
        evidence: [{ kind: 'completion_note', ref: 'artifact://cross-task', summary: 'done' }],
        idempotencyKey: 'supervisor-actions:evidence-provenance:cross-task',
      }),
      'authority_not_granted'
    )
  })

  test('standalone AttachEvidence rejects supervisor runs without persisted attachEvidence capability', () => {
    const { kernel, task } = createKernel()
    startSupervisorRun(kernel, { launchRuns: true }, 'supervisor-run-attach-no-capability')

    expectReject(
      kernel.attachEvidence({
        taskId: task.taskId,
        actor: supervisor,
        supervisorRunId: 'supervisor-run-attach-no-capability',
        evidence: [{ kind: 'completion_note', ref: 'artifact://supervisor-note', summary: 'done' }],
        idempotencyKey: 'supervisor-actions:evidence-provenance:no-attach-capability',
      }),
      'capability_not_granted'
    )
    expect(kernel.listEvidence(task.taskId)).toHaveLength(0)
  })

  test('Escalate records an event and creates a canonical human review obligation effect', () => {
    const { kernel, task } = createKernel()
    startSupervisorRun(kernel, { escalate: true })

    const escalated = submit(
      kernel,
      {
        type: 'escalate',
        reason: 'policy uncertainty',
        severity: 'high',
        audience: 'maintainers',
      } as SupervisorAction,
      { key: 'supervisor-actions:escalate' }
    )

    expect(escalated.ok).toBe(true)
    expect(kernel.listEvents(task.taskId)).toContainEqual(
      expect.objectContaining({
        type: 'supervisor.escalated',
        supervisorRunId: 'supervisor-run-1',
        payload: expect.objectContaining({
          reason: 'policy uncertainty',
          severity: 'high',
          audience: 'maintainers',
        }),
      })
    )
    expect(kernel.listEffectIntents(task.taskId)).toContainEqual(
      expect.objectContaining({
        kind: 'create_obligation',
        payload: expect.objectContaining({ kind: 'human_review', reason: 'policy uncertainty' }),
      })
    )
  })

  test('PauseSupervision requires the persisted pauseSupervision capability but UnpauseSupervision remains allowed while paused', () => {
    const { kernel } = createKernel()
    startSupervisorRun(kernel, {})

    expectReject(
      submit(
        kernel,
        { type: 'pause_supervision', reason: 'missing persisted capability' } as SupervisorAction,
        {
          capabilities: { pauseSupervision: true },
          key: 'supervisor-actions:pause:no-capability',
        }
      ),
      'capability_not_granted'
    )

    startSupervisorRun(kernel, { pauseSupervision: true }, 'supervisor-run-pause-allowed')
    const paused = submit(
      kernel,
      { type: 'pause_supervision', reason: 'human handoff' } as SupervisorAction,
      { runId: 'supervisor-run-pause-allowed', key: 'supervisor-actions:pause:allowed' }
    )
    expect(paused.ok).toBe(true)

    const unpaused = submit(
      kernel,
      { type: 'unpause_supervision', reason: 'ready' } as SupervisorAction,
      {
        runId: 'supervisor-run-pause-allowed',
        capabilities: { pauseSupervision: false },
        key: 'supervisor-actions:unpause:allowed-without-pause-cap',
      }
    )
    expect(unpaused.ok).toBe(true)
  })

  test('PauseSupervision and UnpauseSupervision update persisted run state and gate later actions', () => {
    const { kernel, task } = createKernel()
    startSupervisorRun(kernel, { pauseSupervision: true, createObligations: true })

    const paused = submit(
      kernel,
      { type: 'pause_supervision', reason: 'waiting for human decision' } as SupervisorAction,
      { key: 'supervisor-actions:pause' }
    )
    expect(paused.ok).toBe(true)
    expect(kernel.listSupervisorRuns(task.taskId)).toContainEqual(
      expect.objectContaining({
        runId: 'supervisor-run-1',
        paused: true,
        pausedReason: 'waiting for human decision',
      })
    )
    expect(kernel.listEvents(task.taskId)).toContainEqual(
      expect.objectContaining({
        type: 'supervisor.paused',
        supervisorRunId: 'supervisor-run-1',
      })
    )

    expectReject(
      submit(
        kernel,
        {
          type: 'create_obligation',
          kind: 'missing_evidence',
          summary: 'need more detail',
          blocking: false,
        } as SupervisorAction,
        { key: 'supervisor-actions:paused:block' }
      ),
      'supervisor_paused' as WorkflowRejectionCode
    )

    const unpaused = submit(
      kernel,
      { type: 'unpause_supervision', reason: 'human cleared' } as SupervisorAction,
      { key: 'supervisor-actions:unpause' }
    )
    expect(unpaused.ok).toBe(true)
    expect(kernel.listSupervisorRuns(task.taskId)).toContainEqual(
      expect.objectContaining({ runId: 'supervisor-run-1', paused: false })
    )
    expect(kernel.listEvents(task.taskId)).toContainEqual(
      expect.objectContaining({
        type: 'supervisor.unpaused',
        supervisorRunId: 'supervisor-run-1',
      })
    )

    const accepted = submit(
      kernel,
      {
        type: 'create_obligation',
        kind: 'missing_evidence',
        summary: 'need more detail',
        blocking: false,
      } as SupervisorAction,
      { key: 'supervisor-actions:unpaused:accepted' }
    )
    expect(accepted.ok).toBe(true)
  })

  test('submitControlAction authorizes from persisted supervisor run, actor, and task ownership', () => {
    const { kernel } = createKernel()
    startSupervisorRun(kernel, {})

    expectReject(
      submit(
        kernel,
        {
          type: 'create_obligation',
          kind: 'missing_evidence',
          summary: 'request-body capabilities must be ignored',
        } as SupervisorAction,
        {
          capabilities: { createObligations: true },
          key: 'supervisor-actions:auth:body-capability',
        }
      ),
      'capability_not_granted'
    )

    startSupervisorRun(kernel, { createObligations: true }, 'supervisor-run-auth')
    expectReject(
      submit(
        kernel,
        {
          type: 'create_obligation',
          kind: 'missing_evidence',
          summary: 'wrong actor',
        } as SupervisorAction,
        {
          runId: 'supervisor-run-auth',
          actor: otherSupervisor,
          key: 'supervisor-actions:auth:actor-mismatch',
        }
      ),
      'authority_not_granted'
    )

    const otherTask = kernel.createTask({
      taskId: 'task-other',
      projectId: 'agent-spaces',
      workflow: { id: 'basic', version: 1 },
      goal: 'other task',
      roleBindings: { owner },
      idempotencyKey: 'supervisor-actions:auth:create-other',
    })
    expect(otherTask.ok).toBe(true)

    expectReject(
      submit(
        kernel,
        {
          type: 'create_obligation',
          kind: 'missing_evidence',
          summary: 'wrong task',
        } as SupervisorAction,
        {
          taskId: 'task-other',
          runId: 'supervisor-run-auth',
          capabilities: { createObligations: true },
          key: 'supervisor-actions:auth:wrong-task',
        }
      ),
      'authority_not_granted'
    )
  })
})
