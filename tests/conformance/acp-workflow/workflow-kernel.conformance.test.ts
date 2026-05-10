import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  type WorkflowRejectionCode,
  createInMemoryWorkflowKernel,
  stableJson,
} from '../../../packages/acp-core/src/workflow/index.js'
import { basicWorkflowV1, workflowFixtures } from './fixtures/workflows.js'
import participantActiveGolden from './golden/participant-active.json'
import participantBlockedGolden from './golden/participant-blocked.json'
import supervisorAnomalyGolden from './golden/supervisor-anomaly.json'
import supervisorCleanGolden from './golden/supervisor-clean.json'
import supervisorMissingEvidenceGolden from './golden/supervisor-missing-evidence.json'

const implementer: ActorRef = { kind: 'agent', id: 'larry' }
const tester: ActorRef = { kind: 'agent', id: 'curly' }
const requester: ActorRef = { kind: 'human', id: 'alex' }
const approver: ActorRef = { kind: 'human', id: 'pat' }
const supervisor: ActorRef = { kind: 'agent', id: 'coordinator' }

function seededKernel() {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-09T12:00:00.000Z' })
  for (const definition of workflowFixtures) {
    kernel.publishWorkflowDefinition(definition)
  }
  return kernel
}

function createCodeTask() {
  const kernel = seededKernel()
  const created = kernel.createTask({
    taskId: 'task-code-1',
    projectId: 'demo',
    workflow: { id: 'code_defect_fastlane', version: 1 },
    goal: 'Fix checkout regression',
    risk: 'medium',
    roleBindings: {
      implementer,
      tester,
    },
    supervisor: {
      actor: supervisor,
      autonomy: 'managed',
      capabilities: {
        launchRuns: true,
        createObligations: true,
        satisfyObligations: true,
        requestHumanInput: true,
        proposeWorkflowPatches: true,
      },
    },
    idempotencyKey: 'task:create:code-1',
  })
  if (!created.ok) {
    throw new Error(created.error.message)
  }
  return { kernel, task: created.task }
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

describe('ACP workflow kernel invariants', () => {
  test('publishes immutable WorkflowDefinitions and pins tasks to id/version/hash', () => {
    const kernel = seededKernel()
    const published = kernel.getWorkflowDefinition('basic', 1)
    expect(published?.hash).toMatch(/^sha256:/)
    expect(Object.isFrozen(published)).toBe(true)

    const created = kernel.createTask({
      taskId: 'task-basic-1',
      projectId: 'demo',
      workflow: { id: 'basic', version: 1 },
      goal: 'Track generic work durably',
      roleBindings: { owner: implementer },
      idempotencyKey: 'task:create:basic-1',
    })

    expect(created.ok).toBe(true)
    if (created.ok) {
      expect(created.task.workflow).toEqual({
        id: 'basic',
        version: 1,
        hash: published?.hash,
      })
      expect(created.task).not.toHaveProperty('workflowPreset')
      expect(created.task).not.toHaveProperty('presetVersion')
      expect(created.task).not.toHaveProperty('lifecycleState')
    }
  })

  test('durable generic work uses basic@1 instead of preset-less lifecycle mutation', () => {
    const kernel = seededKernel()
    expectReject(
      kernel.createTask({
        taskId: 'task-no-workflow',
        projectId: 'demo',
        goal: 'No preset-less durable records',
        roleBindings: { owner: implementer },
        idempotencyKey: 'task:create:no-workflow',
      }),
      'workflow_required'
    )
  })

  test('WorkState accepts only open, active, waiting, and closed statuses', () => {
    const kernel = seededKernel()
    for (const status of ['completed', 'cancelled', 'failed']) {
      expectReject(
        kernel.createTask({
          taskId: `task-bad-status-${status}`,
          projectId: 'demo',
          workflow: {
            definition: {
              ...basicWorkflowV1,
              id: `bad_${status}`,
              initial: { status, phase: 'todo' },
            },
          },
          goal: 'Reject legacy lifecycle statuses',
          roleBindings: { owner: implementer },
          idempotencyKey: `task:create:bad-status:${status}`,
        }),
        'invalid_work_state'
      )
    }
  })

  test('transition application uses transitionId, not toPhase, and rejects invalid from-state', () => {
    const { kernel, task } = createCodeTask()
    const start = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: task.version,
      idempotencyKey: 'transition:start',
    })
    expect(start.ok).toBe(true)

    const invalid = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 1,
      idempotencyKey: 'transition:start-again',
    })
    expectReject(invalid, 'state_mismatch')
  })

  test('transition rejects missing evidence and unbound self-asserted roles', () => {
    const { kernel, task } = createCodeTask()
    kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 0,
      idempotencyKey: 'transition:start',
    })

    expectReject(
      kernel.applyTransition({
        taskId: task.taskId,
        transitionId: 'implement_fix',
        actor: implementer,
        role: 'implementer',
        expectedTaskVersion: 1,
        idempotencyKey: 'transition:missing-evidence',
      }),
      'missing_evidence'
    )

    expectReject(
      kernel.applyTransition({
        taskId: task.taskId,
        transitionId: 'implement_fix',
        actor: { kind: 'agent', id: 'mallory' },
        role: 'implementer',
        expectedTaskVersion: 1,
        inlineEvidence: [
          { kind: 'commit_ref', ref: 'git:self-assert' },
          { kind: 'regression_test', ref: 'test:self-assert' },
        ],
        idempotencyKey: 'transition:self-assert-implementer',
      }),
      'role_not_bound'
    )
  })

  test('SoD rejects the same actor for implementer and tester when required', () => {
    const kernel = seededKernel()
    const created = kernel.createTask({
      taskId: 'task-sod-1',
      projectId: 'demo',
      workflow: { id: 'code_defect_fastlane', version: 1 },
      goal: 'Reject self verification',
      risk: 'medium',
      roleBindings: {
        implementer,
        tester: implementer,
      },
      idempotencyKey: 'task:create:sod-1',
    })
    expect(created.ok).toBe(true)
    kernel.applyTransition({
      taskId: 'task-sod-1',
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 0,
      idempotencyKey: 'transition:sod:start',
    })
    kernel.applyTransition({
      taskId: 'task-sod-1',
      transitionId: 'implement_fix',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 1,
      inlineEvidence: [
        { kind: 'commit_ref', ref: 'git:abc123' },
        { kind: 'regression_test', ref: 'test:checkout' },
      ],
      idempotencyKey: 'transition:sod:fix',
    })

    expectReject(
      kernel.applyTransition({
        taskId: 'task-sod-1',
        transitionId: 'verify',
        actor: implementer,
        role: 'tester',
        expectedTaskVersion: 2,
        inlineEvidence: [{ kind: 'verification_report', ref: 'artifact:qa', summary: 'passed' }],
        idempotencyKey: 'transition:sod:verify',
      }),
      'sod_violation'
    )
  })

  test('idempotency replays same payload, conflicts on different payload, and rejects missing keys', () => {
    const { kernel, task } = createCodeTask()
    expectReject(
      kernel.applyTransition({
        taskId: task.taskId,
        transitionId: 'start',
        actor: implementer,
        role: 'implementer',
        expectedTaskVersion: 0,
      }),
      'idempotency_key_required'
    )

    const first = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 0,
      idempotencyKey: 'transition:idempotent:start',
    })
    const replay = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 0,
      idempotencyKey: 'transition:idempotent:start',
    })
    const conflict = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'implement_fix',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 1,
      idempotencyKey: 'transition:idempotent:start',
    })

    expect(first.ok).toBe(true)
    expect(replay).toEqual(first)
    expectReject(conflict, 'idempotency_conflict')
  })

  test('version and context hash conflicts are stable rejection codes', () => {
    const { kernel, task } = createCodeTask()
    const participantContext = kernel.compileParticipantContext({
      taskId: task.taskId,
      runId: 'run-implementer-1',
      actor: implementer,
      role: 'implementer',
      sessionRef: {
        scopeRef: 'agent:larry:project:demo:task:task-code-1:role:implementer',
        laneRef: 'main',
      },
      idempotencyPrefix: 'idem:participant',
    })
    expectReject(
      kernel.applyTransition({
        taskId: task.taskId,
        transitionId: 'start',
        actor: implementer,
        role: 'implementer',
        expectedTaskVersion: 4,
        contextHash: participantContext.contextHash,
        idempotencyKey: 'transition:stale-version',
      }),
      'version_conflict'
    )
    expectReject(
      kernel.applyTransition({
        taskId: task.taskId,
        transitionId: 'start',
        actor: implementer,
        role: 'implementer',
        expectedTaskVersion: 0,
        contextHash: 'sha256:not-the-context',
        idempotencyKey: 'transition:stale-context',
      }),
      'context_stale'
    )
  })

  test('code workflow scenario records ledger, evidence, handoff/wake effects, and closure', () => {
    const { kernel, task } = createCodeTask()
    kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 0,
      idempotencyKey: 'scenario:code:start',
    })
    kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'implement_fix',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 1,
      inlineEvidence: [
        { kind: 'commit_ref', ref: 'git:abc123' },
        { kind: 'regression_test', ref: 'test:checkout' },
      ],
      idempotencyKey: 'scenario:code:fix',
    })
    kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'verify',
      actor: tester,
      role: 'tester',
      expectedTaskVersion: 2,
      inlineEvidence: [{ kind: 'verification_report', ref: 'artifact:qa', summary: 'passed' }],
      idempotencyKey: 'scenario:code:verify',
    })
    const closed = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'close_success',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 3,
      idempotencyKey: 'scenario:code:close',
    })

    expect(closed.ok).toBe(true)
    if (closed.ok) {
      expect(closed.task.state).toEqual({ status: 'closed', phase: 'verified', outcome: 'success' })
    }
    expect(kernel.listEvents(task.taskId).map((event) => event.type)).toEqual([
      'task.created',
      'transition.applied',
      'evidence.attached',
      'evidence.attached',
      'transition.applied',
      'effect_intent.created',
      'effect_intent.created',
      'evidence.attached',
      'transition.applied',
      'transition.applied',
    ])
    expect(kernel.listEvidence(task.taskId).map((evidence) => evidence.kind)).toEqual([
      'commit_ref',
      'regression_test',
      'verification_report',
    ])
    expect(kernel.listEffectIntents(task.taskId).map((effect) => effect.kind)).toEqual([
      'declare_handoff',
      'wake_role_session',
    ])
  })

  test('missing evidence recovery creates a blocking obligation and later legal transition', () => {
    const { kernel, task } = createCodeTask()
    kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 0,
      idempotencyKey: 'scenario:missing:start',
    })
    expectReject(
      kernel.applyTransition({
        taskId: task.taskId,
        transitionId: 'implement_fix',
        actor: implementer,
        role: 'implementer',
        expectedTaskVersion: 1,
        idempotencyKey: 'scenario:missing:reject',
      }),
      'missing_evidence'
    )
    const obligation = kernel.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'run-supervisor-1',
      contextHash: kernel.compileSupervisorContext({
        taskId: task.taskId,
        runId: 'run-supervisor-1',
        actor: supervisor,
        autonomy: 'managed',
        capabilities: { createObligations: true },
        idempotencyPrefix: 'idem:supervisor',
      }).contextHash,
      expectedTaskVersion: 1,
      action: {
        type: 'create_obligation',
        kind: 'missing_evidence',
        ownerRole: 'implementer',
        summary: 'Need commit and regression test evidence',
        blocking: true,
      },
      idempotencyKey: 'scenario:missing:obligation',
    })
    expect(obligation.ok).toBe(true)
    expect(kernel.getTask(task.taskId)?.state.status).toBe('waiting')

    const satisfied = kernel.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'run-supervisor-1',
      expectedTaskVersion: 2,
      action: {
        type: 'satisfy_obligation',
        obligationId: kernel.listObligations(task.taskId)[0]!.obligationId,
        evidence: [
          { kind: 'commit_ref', ref: 'git:def456' },
          { kind: 'regression_test', ref: 'test:checkout' },
        ],
      },
      idempotencyKey: 'scenario:missing:satisfy',
    })
    expect(satisfied.ok).toBe(true)
    expect(kernel.getTask(task.taskId)?.state.status).toBe('active')

    const fixed = kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'implement_fix',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 3,
      idempotencyKey: 'scenario:missing:fix',
    })
    expect(fixed.ok).toBe(true)
  })

  test('external approval scenario waits on blocking obligation, resumes, and closes', () => {
    const kernel = seededKernel()
    const created = kernel.createTask({
      taskId: 'task-approval-1',
      projectId: 'demo',
      workflow: { id: 'external_dependency_approval', version: 1 },
      goal: 'Approve vendor contract',
      risk: 'medium',
      roleBindings: {
        requester,
        approver,
        vendor_proxy: { kind: 'human', id: 'vendor-contact' },
      },
      supervisor: {
        actor: supervisor,
        autonomy: 'managed',
        capabilities: { createChildTasks: true, createObligations: true, satisfyObligations: true },
      },
      idempotencyKey: 'task:create:approval-1',
    })
    expect(created.ok).toBe(true)
    kernel.applyTransition({
      taskId: 'task-approval-1',
      transitionId: 'submit_request',
      actor: requester,
      role: 'requester',
      expectedTaskVersion: 0,
      inlineEvidence: [{ kind: 'request_packet', ref: 'doc:request', summary: 'Request packet' }],
      idempotencyKey: 'scenario:approval:submit',
    })
    const waiting = kernel.applyTransition({
      taskId: 'task-approval-1',
      transitionId: 'wait_for_vendor',
      actor: requester,
      role: 'requester',
      expectedTaskVersion: 1,
      idempotencyKey: 'scenario:approval:wait',
    })
    expect(waiting.ok).toBe(true)
    expect(kernel.getTask('task-approval-1')?.state.status).toBe('waiting')
    expect(kernel.listObligations('task-approval-1')).toEqual([
      expect.objectContaining({ kind: 'vendor_response', status: 'open', blocking: true }),
    ])
    expect(kernel.listEffectIntents('task-approval-1').map((effect) => effect.kind)).toEqual([
      'create_obligation',
      'create_child_task',
    ])

    kernel.submitControlAction({
      taskId: 'task-approval-1',
      supervisorRunId: 'run-supervisor-approval',
      expectedTaskVersion: 2,
      action: {
        type: 'satisfy_obligation',
        obligationId: kernel.listObligations('task-approval-1')[0]!.obligationId,
        evidence: [{ kind: 'vendor_response', ref: 'mail:vendor', summary: 'Vendor answered' }],
      },
      idempotencyKey: 'scenario:approval:satisfy',
    })
    kernel.applyTransition({
      taskId: 'task-approval-1',
      transitionId: 'resume_review',
      actor: approver,
      role: 'approver',
      expectedTaskVersion: 3,
      idempotencyKey: 'scenario:approval:resume',
    })
    const approved = kernel.applyTransition({
      taskId: 'task-approval-1',
      transitionId: 'approve',
      actor: approver,
      role: 'approver',
      expectedTaskVersion: 4,
      inlineEvidence: [{ kind: 'approval_record', ref: 'doc:approval', summary: 'Approved' }],
      idempotencyKey: 'scenario:approval:approve',
    })
    expect(approved.ok).toBe(true)
    if (approved.ok) {
      expect(approved.task.state).toEqual({ status: 'closed', phase: 'review', outcome: 'success' })
    }
  })

  test('participant and supervisor contexts match golden JSON contracts', () => {
    const { kernel, task } = createCodeTask()
    const active = kernel.compileParticipantContext({
      taskId: task.taskId,
      runId: 'run-implementer-1',
      actor: implementer,
      role: 'implementer',
      sessionRef: {
        scopeRef: 'agent:larry:project:demo:task:task-code-1:role:implementer',
        laneRef: 'main',
      },
      idempotencyPrefix: 'idem:participant',
    })
    expect(JSON.parse(stableJson(active))).toEqual(participantActiveGolden)

    kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 0,
      idempotencyKey: 'golden:start',
    })
    kernel.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'run-supervisor-1',
      expectedTaskVersion: 1,
      action: {
        type: 'create_obligation',
        kind: 'missing_evidence',
        ownerRole: 'implementer',
        summary: 'Need implementation artifacts',
        blocking: true,
      },
      idempotencyKey: 'golden:blocker',
    })
    const blocked = kernel.compileParticipantContext({
      taskId: task.taskId,
      runId: 'run-implementer-1',
      actor: implementer,
      role: 'implementer',
      sessionRef: {
        scopeRef: 'agent:larry:project:demo:task:task-code-1:role:implementer',
        laneRef: 'main',
      },
      idempotencyPrefix: 'idem:participant',
    })
    expect(JSON.parse(stableJson(blocked))).toEqual(participantBlockedGolden)

    const cleanSupervisor = seededKernel()
    const cleanTask = cleanSupervisor.createTask({
      taskId: 'task-clean-supervisor',
      projectId: 'demo',
      workflow: { id: 'code_defect_fastlane', version: 1 },
      goal: 'Clean supervisor context',
      roleBindings: { implementer, tester },
      idempotencyKey: 'task:create:clean-supervisor',
    })
    expect(cleanTask.ok).toBe(true)
    expect(
      JSON.parse(
        stableJson(
          cleanSupervisor.compileSupervisorContext({
            taskId: 'task-clean-supervisor',
            runId: 'run-supervisor-clean',
            actor: supervisor,
            autonomy: 'managed',
            capabilities: {
              launchRuns: true,
              createObligations: true,
              proposeWorkflowPatches: true,
            },
            idempotencyPrefix: 'idem:supervisor',
          })
        )
      )
    ).toEqual(supervisorCleanGolden)
    expect(
      JSON.parse(
        stableJson(
          kernel.compileSupervisorContext({
            taskId: task.taskId,
            runId: 'run-supervisor-1',
            actor: supervisor,
            autonomy: 'managed',
            capabilities: {
              launchRuns: true,
              createObligations: true,
              proposeWorkflowPatches: true,
            },
            idempotencyPrefix: 'idem:supervisor',
          })
        )
      )
    ).toEqual(supervisorMissingEvidenceGolden)
  })

  test('supervisor context offers satisfy-obligation actions for open obligations', () => {
    const { kernel, task } = createCodeTask()
    kernel.applyTransition({
      taskId: task.taskId,
      transitionId: 'start',
      actor: implementer,
      role: 'implementer',
      expectedTaskVersion: 0,
      idempotencyKey: 'supervisor-satisfy-context:start',
    })
    const blocked = kernel.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'run-supervisor-1',
      expectedTaskVersion: 1,
      capabilities: { createObligations: true },
      action: {
        type: 'create_obligation',
        kind: 'missing_evidence',
        ownerRole: 'implementer',
        summary: 'Need implementation artifacts',
        blocking: true,
      },
      idempotencyKey: 'supervisor-satisfy-context:blocker',
    })
    expect(blocked.ok).toBe(true)

    const obligation = kernel.listObligations(task.taskId)[0]
    expect(obligation).toBeDefined()
    const context = kernel.compileSupervisorContext({
      taskId: task.taskId,
      runId: 'run-supervisor-1',
      actor: supervisor,
      autonomy: 'managed',
      capabilities: { satisfyObligations: true },
      idempotencyPrefix: 'idem:supervisor',
    }) as { allowedControlActions: unknown[] }

    expect(context.allowedControlActions).toEqual([
      expect.objectContaining({
        type: 'satisfy_obligation',
        obligationId: obligation?.obligationId,
        command: expect.objectContaining({
          args: expect.objectContaining({
            action: { type: 'satisfy_obligation', obligationId: obligation?.obligationId },
          }),
        }),
      }),
    ])
  })

  test('supervisor applies one checked control action at a time', () => {
    const { kernel, task } = createCodeTask()
    expectReject(
      kernel.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'run-supervisor-1',
        expectedTaskVersion: 0,
        action: [
          { type: 'launch_participant_run', role: 'implementer', actor: implementer },
          { type: 'create_obligation', kind: 'missing_evidence', summary: 'bundle' },
        ],
        idempotencyKey: 'control:bundle',
      }),
      'one_control_action_required'
    )
    const noSupervisorTask = kernel.createTask({
      taskId: 'task-no-supervisor-capability',
      projectId: 'demo',
      workflow: { id: 'basic', version: 1 },
      goal: 'No implicit supervisor capabilities',
      roleBindings: { owner: implementer },
      idempotencyKey: 'task:create:no-supervisor-capability',
    })
    expect(noSupervisorTask.ok).toBe(true)
    expectReject(
      kernel.submitControlAction({
        taskId: 'task-no-supervisor-capability',
        supervisorRunId: 'run-supervisor-1',
        expectedTaskVersion: 0,
        action: { type: 'launch_participant_run', role: 'owner', actor: implementer },
        idempotencyKey: 'control:no-capability',
      }),
      'capability_not_granted'
    )
    const launched = kernel.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'run-supervisor-1',
      expectedTaskVersion: 0,
      action: { type: 'launch_participant_run', role: 'implementer', actor: implementer },
      capabilities: { launchRuns: true },
      idempotencyKey: 'control:launch',
    })
    expect(launched.ok).toBe(true)
    expect(kernel.listParticipantRuns(task.taskId)).toEqual([
      expect.objectContaining({ role: 'implementer', actor: implementer }),
    ])
  })

  test('workflow patch proposals record anomalies without mutating the active WorkflowDefinition', () => {
    const { kernel, task } = createCodeTask()
    const before = kernel.getWorkflowDefinition('code_defect_fastlane', 1)
    const proposal = kernel.submitControlAction({
      taskId: task.taskId,
      supervisorRunId: 'run-supervisor-1',
      expectedTaskVersion: 0,
      capabilities: { proposeWorkflowPatches: true },
      action: {
        type: 'propose_workflow_patch',
        category: 'no_legal_transition',
        summary: 'Need a recovery transition for inconclusive verification',
        proposedRecovery: 'Add a retry verification transition.',
        patchKind: 'add_transition',
        patch: { transitionId: 'retry_verify' },
        rationaleSummary: 'Repeated QA inconclusive state is currently supervisor-only.',
      },
      idempotencyKey: 'control:patch',
    })
    const after = kernel.getWorkflowDefinition('code_defect_fastlane', 1)
    expect(proposal.ok).toBe(true)
    expect(after).toEqual(before)
    expect(kernel.listAnomalies(task.taskId)).toEqual([
      expect.objectContaining({ category: 'no_legal_transition' }),
    ])
    expect(kernel.listWorkflowPatchProposals(task.taskId)).toEqual([
      expect.objectContaining({
        baseWorkflow: before?.workflow,
        patchKind: 'add_transition',
        status: 'proposed',
      }),
    ])
    expect(
      JSON.parse(
        stableJson(
          kernel.compileSupervisorContext({
            taskId: task.taskId,
            runId: 'run-supervisor-1',
            actor: supervisor,
            autonomy: 'managed',
            capabilities: { proposeWorkflowPatches: true },
            idempotencyPrefix: 'idem:supervisor',
          })
        )
      )
    ).toEqual(supervisorAnomalyGolden)
  })
})
