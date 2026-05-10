import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import {
  type ActorRef,
  type EvidenceInput,
  type SupervisorBinding,
  type WorkState,
  type WorkflowDefinition,
  type WorkflowRejectionCode,
  createInMemoryWorkflowKernel,
} from '../../../packages/acp-core/src/workflow/index.js'

type Scenario = {
  scenarioId: string
  manualOnly?: boolean | undefined
  workflow: { id: string; version: number; definitionFile: string }
  actors: Array<{ binding: string; actor: ActorRef }>
  supervisor?: SupervisorBinding | undefined
  steps: ScenarioStep[]
  negativeChecks: Array<{ name: string; expectedRejection: WorkflowRejectionCode }>
}

type ScenarioStep = {
  stepId: string
  actorBinding: string
  kernel?: { op: 'createTask'; args: Record<string, unknown> } | undefined
  evidence?: EvidenceInput[] | undefined
  transitionId?: string | undefined
  controlAction?:
    | {
        type: 'satisfy_obligation'
        obligationKind: string
        evidence?: EvidenceInput[] | undefined
      }
    | undefined
  expectedStateAfter?: (Partial<WorkState> & { note?: string | undefined }) | undefined
  expectedEffects?:
    | Array<{
        kind: string
        payload?: Record<string, unknown> | undefined
      }>
    | undefined
}

type ScenarioFixture = {
  dir: string
  scenario: Scenario
  workflow: WorkflowDefinition
}

const scenariosRoot = join(process.cwd(), 'scenarios', 'flow-presets')

function loadScenarios(): ScenarioFixture[] {
  return readdirSync(scenariosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(scenariosRoot, entry.name)
      return {
        dir,
        scenario: JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8')) as Scenario,
        workflow: JSON.parse(
          readFileSync(join(dir, 'workflow.json'), 'utf8')
        ) as WorkflowDefinition,
      }
    })
    .filter((fixture) => fixture.scenario.manualOnly !== true)
    .sort((a, b) => a.scenario.scenarioId.localeCompare(b.scenario.scenarioId))
}

function actorFor(scenario: Scenario, binding: string): ActorRef {
  const actor = scenario.actors.find((entry) => entry.binding === binding)?.actor
  if (actor === undefined) {
    throw new Error(`Missing actor binding ${binding} in ${scenario.scenarioId}`)
  }
  return actor
}

function actorForStep(
  scenario: Scenario,
  binding: string,
  roleBindingsOverride?: Record<string, ActorRef> | undefined
): ActorRef {
  return roleBindingsOverride?.[binding] ?? actorFor(scenario, binding)
}

function expectStateMatches(actual: WorkState, expected: Partial<WorkState> | undefined): void {
  if (expected === undefined) {
    return
  }
  if (expected.status !== undefined) {
    expect(actual.status).toBe(expected.status)
  }
  if (expected.phase !== undefined) {
    expect(actual.phase).toBe(expected.phase)
  }
  if (expected.outcome !== undefined) {
    expect(actual.outcome).toBe(expected.outcome)
  }
}

function expectReject(
  result: { ok: true } | { ok: false; error: { code: WorkflowRejectionCode } },
  code: WorkflowRejectionCode
): void {
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.error.code).toBe(code)
  }
}

function createScenarioKernel(fixture: ScenarioFixture) {
  const kernel = createInMemoryWorkflowKernel({ now: '2026-05-09T12:00:00.000Z' })
  const published = kernel.publishWorkflowDefinition(fixture.workflow)
  expect(published.id).toBe(fixture.scenario.workflow.id)
  expect(published.version).toBe(fixture.scenario.workflow.version)
  expect(published.hash).toMatch(/^sha256:/)
  return kernel
}

function findOpenObligationId(
  kernel: ReturnType<typeof createInMemoryWorkflowKernel>,
  taskId: string,
  kind: string
): string {
  const obligation = kernel
    .listObligations(taskId)
    .find((candidate) => candidate.kind === kind && candidate.status === 'open')
  if (obligation === undefined) {
    throw new Error(`Missing open obligation ${kind} on ${taskId}`)
  }
  return obligation.obligationId
}

function runHappyPath(
  fixture: ScenarioFixture,
  options: {
    stopAfterStepId?: string | undefined
    skipStepIds?: readonly string[] | undefined
    roleBindingsOverride?: Record<string, ActorRef> | undefined
  } = {}
) {
  const kernel = createScenarioKernel(fixture)
  const { scenario } = fixture
  const taskId = scenario.steps[0]?.kernel?.args['taskId'] as string
  const pendingEvidence: EvidenceInput[] = []
  const supervisorRunId = `scenario:${scenario.scenarioId}:supervisor`
  let supervisorRunStarted = false

  for (const step of scenario.steps) {
    if (options.skipStepIds?.includes(step.stepId)) {
      continue
    }

    const actor = actorForStep(scenario, step.actorBinding, options.roleBindingsOverride)
    if (step.kernel?.op === 'createTask') {
      const args = {
        ...step.kernel.args,
        ...(scenario.supervisor !== undefined ? { supervisor: scenario.supervisor } : {}),
        ...(options.roleBindingsOverride !== undefined
          ? { roleBindings: options.roleBindingsOverride }
          : {}),
      } as Parameters<typeof kernel.createTask>[0]
      const created = kernel.createTask(args)
      expect(created.ok).toBe(true)
      if (created.ok) {
        expectStateMatches(created.task.state, step.expectedStateAfter)
        if (scenario.supervisor !== undefined && !supervisorRunStarted) {
          const startedRun = kernel.startSupervisorRun({
            taskId,
            runId: supervisorRunId,
            supervisor: scenario.supervisor.actor,
            autonomy: scenario.supervisor.autonomy,
            capabilities: scenario.supervisor.capabilities,
            idempotencyKey: `${supervisorRunId}:start`,
          })
          expect(startedRun.ok).toBe(true)
          supervisorRunStarted = true
        }
      }
    }

    if (step.evidence !== undefined) {
      pendingEvidence.push(...step.evidence)
    }

    if (step.controlAction !== undefined) {
      const obligationId = findOpenObligationId(kernel, taskId, step.controlAction.obligationKind)
      const evidence = [...pendingEvidence.splice(0), ...(step.controlAction.evidence ?? [])]
      const satisfied = kernel.submitControlAction({
        taskId,
        supervisorRunId,
        action: {
          type: 'satisfy_obligation',
          obligationId,
          ...(evidence.length > 0 ? { evidence } : {}),
        },
        idempotencyKey: `scenario:${scenario.scenarioId}:${step.stepId}:control`,
      })
      expect(satisfied.ok).toBe(true)
      if (satisfied.ok) {
        expectStateMatches(satisfied.task.state, step.expectedStateAfter)
      }
    }

    if (step.transitionId !== undefined) {
      const beforeEffectCount = kernel.listEffectIntents(taskId).length
      const task = kernel.getTask(taskId)
      if (task === undefined) {
        throw new Error(`Missing task ${taskId}`)
      }
      const transitioned = kernel.applyTransition({
        taskId,
        transitionId: step.transitionId,
        actor,
        role: step.actorBinding,
        expectedTaskVersion: task.version,
        ...(pendingEvidence.length > 0 ? { inlineEvidence: pendingEvidence.splice(0) } : {}),
        idempotencyKey: `scenario:${scenario.scenarioId}:${step.stepId}:transition`,
      })
      expect(transitioned.ok).toBe(true)
      if (transitioned.ok) {
        expectStateMatches(transitioned.task.state, step.expectedStateAfter)
      }
      const newEffects = kernel.listEffectIntents(taskId).slice(beforeEffectCount)
      for (const effect of step.expectedEffects ?? []) {
        expect(newEffects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: effect.kind,
              ...(effect.payload !== undefined
                ? { payload: expect.objectContaining(effect.payload) }
                : {}),
            }),
          ])
        )
      }
    }

    const currentTask = kernel.getTask(taskId)
    if (currentTask !== undefined) {
      expectStateMatches(currentTask.state, step.expectedStateAfter)
    }

    if (options.stopAfterStepId === step.stepId) {
      break
    }
  }

  return { kernel, taskId }
}

function applyTransitionExpectingRejection(
  fixture: ScenarioFixture,
  state: ReturnType<typeof runHappyPath>,
  input: {
    transitionId: string
    actor: ActorRef
    role: string
    expected: WorkflowRejectionCode
    inlineEvidence?: EvidenceInput[] | undefined
  }
): void {
  const task = state.kernel.getTask(state.taskId)
  if (task === undefined) {
    throw new Error(`Missing task ${state.taskId}`)
  }
  expectReject(
    state.kernel.applyTransition({
      taskId: state.taskId,
      transitionId: input.transitionId,
      actor: input.actor,
      role: input.role,
      expectedTaskVersion: task.version,
      ...(input.inlineEvidence !== undefined ? { inlineEvidence: input.inlineEvidence } : {}),
      idempotencyKey: `scenario:${fixture.scenario.scenarioId}:negative:${input.transitionId}:${input.role}:${input.expected}`,
    }),
    input.expected
  )
}

function runNegativeCheck(fixture: ScenarioFixture, name: string): void {
  const { scenario } = fixture
  switch (`${scenario.scenarioId}:${name}`) {
    case 'hotfix-implementer-tester:implementer-actor-cannot-act-as-tester': {
      const state = runHappyPath(fixture, { stopAfterStepId: '05-implement-fix' })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'verify',
        actor: actorFor(scenario, 'implementer'),
        role: 'tester',
        expected: 'role_not_bound',
        inlineEvidence: [{ kind: 'verification_report', ref: 'negative:qa' }],
      })
      return
    }
    case 'hotfix-implementer-tester:sod-same-actor-both-roles': {
      const implementer = actorFor(scenario, 'implementer')
      const state = runHappyPath(fixture, {
        stopAfterStepId: '05-implement-fix',
        roleBindingsOverride: { implementer, tester: implementer },
      })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'verify',
        actor: implementer,
        role: 'tester',
        expected: 'sod_violation',
        inlineEvidence: [{ kind: 'verification_report', ref: 'negative:qa' }],
      })
      return
    }
    case 'hotfix-implementer-tester:missing-evidence-blocks-fix': {
      const state = runHappyPath(fixture, {
        stopAfterStepId: '03-start',
        skipStepIds: ['04-attach-fix-evidence'],
      })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'implement_fix',
        actor: actorFor(scenario, 'implementer'),
        role: 'implementer',
        expected: 'missing_evidence',
      })
      return
    }
    case 'support-escalation-customer-response:resume-without-obligation': {
      const state = runHappyPath(fixture, { stopAfterStepId: '06-wait-for-customer' })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'resume_resolution',
        actor: actorFor(scenario, 'support_agent'),
        role: 'support_agent',
        expected: 'obligation_not_satisfied',
        inlineEvidence: [{ kind: 'customer_response', ref: 'negative:customer-response' }],
      })
      return
    }
    case 'support-escalation-customer-response:wait-prevents-direct-resolve': {
      const state = runHappyPath(fixture, { stopAfterStepId: '06-wait-for-customer' })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'resolve',
        actor: actorFor(scenario, 'support_agent'),
        role: 'support_agent',
        expected: 'state_mismatch',
        inlineEvidence: [{ kind: 'resolution_note', ref: 'negative:resolution' }],
      })
      return
    }
    case 'procurement-legal-approval:approver-cannot-be-requester': {
      const requester = actorFor(scenario, 'requester')
      const state = runHappyPath(fixture, {
        stopAfterStepId: '08-legal-completes-review',
        roleBindingsOverride: {
          requester,
          procurement_lead: requester,
          legal_reviewer: actorFor(scenario, 'legal_reviewer'),
        },
      })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'complete_legal_review',
        actor: requester,
        role: 'procurement_lead',
        expected: 'sod_violation',
        inlineEvidence: [{ kind: 'legal_review', ref: 'negative:legal-review' }],
      })
      return
    }
    case 'procurement-legal-approval:approver-cannot-be-legal-reviewer': {
      const procurementLead = actorFor(scenario, 'procurement_lead')
      const state = runHappyPath(fixture, {
        stopAfterStepId: '06-vendor-responds',
        roleBindingsOverride: {
          requester: actorFor(scenario, 'requester'),
          procurement_lead: procurementLead,
          legal_reviewer: procurementLead,
        },
      })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'resume_legal_review',
        actor: procurementLead,
        role: 'legal_reviewer',
        expected: 'sod_violation',
        inlineEvidence: [{ kind: 'vendor_response', ref: 'negative:vendor-response' }],
      })
      return
    }
    case 'procurement-legal-approval:legal-reviewer-cannot-be-requester': {
      const requester = actorFor(scenario, 'requester')
      const state = runHappyPath(fixture, {
        stopAfterStepId: '06-vendor-responds',
        roleBindingsOverride: {
          requester,
          procurement_lead: actorFor(scenario, 'procurement_lead'),
          legal_reviewer: requester,
        },
      })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'resume_legal_review',
        actor: requester,
        role: 'legal_reviewer',
        expected: 'sod_violation',
        inlineEvidence: [{ kind: 'vendor_response', ref: 'negative:vendor-response' }],
      })
      return
    }
    case 'procurement-legal-approval:legal-reviewer-cannot-be-procurement-lead': {
      const procurementLead = actorFor(scenario, 'procurement_lead')
      const state = runHappyPath(fixture, {
        stopAfterStepId: '06-vendor-responds',
        roleBindingsOverride: {
          requester: actorFor(scenario, 'requester'),
          procurement_lead: procurementLead,
          legal_reviewer: procurementLead,
        },
      })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'resume_legal_review',
        actor: procurementLead,
        role: 'legal_reviewer',
        expected: 'sod_violation',
        inlineEvidence: [{ kind: 'vendor_response', ref: 'negative:vendor-response' }],
      })
      return
    }
    case 'procurement-legal-approval:requester-actor-cannot-act-as-procurement-lead': {
      const state = runHappyPath(fixture, { stopAfterStepId: '10-attach-approval-record' })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'approve',
        actor: actorFor(scenario, 'requester'),
        role: 'procurement_lead',
        expected: 'role_not_bound',
        inlineEvidence: [{ kind: 'approval_record', ref: 'negative:approval' }],
      })
      return
    }
    case 'procurement-legal-approval:resume-legal-review-without-vendor': {
      const state = runHappyPath(fixture, { stopAfterStepId: '05-wait-for-vendor' })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'resume_legal_review',
        actor: actorFor(scenario, 'legal_reviewer'),
        role: 'legal_reviewer',
        expected: 'obligation_not_satisfied',
        inlineEvidence: [{ kind: 'vendor_response', ref: 'negative:vendor-response' }],
      })
      return
    }
    case 'procurement-legal-approval:complete-legal-without-legal-review': {
      const state = runHappyPath(fixture, {
        stopAfterStepId: '07-resume-legal-review',
        skipStepIds: ['08-legal-completes-review'],
      })
      applyTransitionExpectingRejection(fixture, state, {
        transitionId: 'complete_legal_review',
        actor: actorFor(scenario, 'procurement_lead'),
        role: 'procurement_lead',
        expected: 'obligation_not_satisfied',
        inlineEvidence: [{ kind: 'legal_review', ref: 'negative:legal-review' }],
      })
      return
    }
    default:
      throw new Error(`Unhandled scenario negative check ${scenario.scenarioId}:${name}`)
  }
}

describe('flow preset scenario artifacts', () => {
  const fixtures = loadScenarios()

  test('discovers all scenario folders', () => {
    expect(fixtures.map((fixture) => fixture.scenario.scenarioId)).toEqual([
      'hotfix-implementer-tester',
      'procurement-legal-approval',
      'support-escalation-customer-response',
    ])
  })

  for (const fixture of fixtures) {
    test(`${fixture.scenario.scenarioId} happy path executes from scenario.json`, () => {
      const { kernel, taskId } = runHappyPath(fixture)
      const task = kernel.getTask(taskId)
      expect(task?.state.status).toBe('closed')
      expect(kernel.listEvents(taskId).length).toBeGreaterThan(0)
      expect(kernel.listEffectIntents(taskId).length).toBeGreaterThan(0)
    })

    for (const negative of fixture.scenario.negativeChecks) {
      test(`${fixture.scenario.scenarioId} negative: ${negative.name}`, () => {
        runNegativeCheck(fixture, negative.name)
      })
    }
  }
})
