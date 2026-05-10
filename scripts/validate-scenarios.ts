#!/usr/bin/env bun
/**
 * Independent end-to-end validator for scenarios/flow-presets/*.
 *
 * Drives each scenario through the in-memory ACP workflow kernel:
 *  - publishWorkflowDefinition(workflow.json)
 *  - createTask(...) per scenario.json step 01
 *  - apply each subsequent transition / control action
 *  - assert expected state, effects, obligations after each step
 *  - run scenario.json negativeChecks against fresh kernel/task fixtures
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  type ActorRef,
  type EffectIntent,
  type EvidenceInput,
  type ObligationRecord,
  type WorkflowControlAction,
  type WorkflowDefinition,
  type WorkflowRejectionCode,
  type WorkflowResult,
  type WorkflowTask,
  createInMemoryWorkflowKernel,
} from '../packages/acp-core/src/workflow/index.js'

type Kernel = ReturnType<typeof createInMemoryWorkflowKernel>

interface ScenarioActorBinding {
  binding: string
  actor: ActorRef
}

interface ScenarioStep {
  stepId: string
  summary: string
  actorBinding: string
  expectedStateAfter?: { status?: string; phase?: string | null; outcome?: string }
  evidence?: EvidenceInput[]
  transitionId?: string
  kernel?: { op: string; args: Record<string, unknown> }
  controlAction?: {
    type: string
    obligationKind?: string
    evidence?: EvidenceInput[]
    supervisorActor?: string
  }
  expectedEffects?: Array<{ kind: string; payload?: Record<string, unknown> }>
}

interface NegativeCheck {
  name: string
  summary: string
  expectedRejection: WorkflowRejectionCode
  note?: string
}

interface Scenario {
  scenarioId: string
  title: string
  workflow: { id: string; version: number; definitionFile: string }
  task: {
    taskId: string
    projectId: string
    goal: string
    risk?: string
    initialFacts?: Record<string, unknown>
  }
  actors: ScenarioActorBinding[]
  supervisor?: {
    actor: ActorRef
    autonomy: 'observe' | 'recommend' | 'managed' | 'autonomous'
    capabilities: Record<string, boolean>
  }
  steps: ScenarioStep[]
  negativeChecks?: NegativeCheck[]
}

interface AssertionFailure {
  step: string
  message: string
}

const SCENARIOS = [
  'scenarios/flow-presets/hotfix-implementer-tester',
  'scenarios/flow-presets/support-escalation-customer-response',
  'scenarios/flow-presets/procurement-legal-approval',
]

const REPO_ROOT = resolve(import.meta.dir, '..')
const NOW = '2026-05-09T12:00:00.000Z'

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function actorByBinding(scenario: Scenario, binding: string): ActorRef {
  if (binding === 'supervisor' && scenario.supervisor) {
    return scenario.supervisor.actor
  }
  const found = scenario.actors.find((a) => a.binding === binding)
  if (!found) throw new Error(`No actor for binding "${binding}"`)
  return found.actor
}

function expectState(
  failures: AssertionFailure[],
  step: string,
  task: WorkflowTask,
  expected: ScenarioStep['expectedStateAfter']
): void {
  if (!expected) return
  if (expected.status && task.state.status !== expected.status) {
    failures.push({
      step,
      message: `state.status: expected ${expected.status}, got ${task.state.status}`,
    })
  }
  if (expected.phase !== undefined && (task.state.phase ?? null) !== (expected.phase ?? null)) {
    failures.push({
      step,
      message: `state.phase: expected ${String(expected.phase)}, got ${String(task.state.phase)}`,
    })
  }
  if (
    expected.outcome !== undefined &&
    (task.state.outcome ?? null) !== (expected.outcome ?? null)
  ) {
    failures.push({
      step,
      message: `state.outcome: expected ${String(expected.outcome)}, got ${String(task.state.outcome)}`,
    })
  }
}

function expectEffects(
  failures: AssertionFailure[],
  step: string,
  produced: EffectIntent[],
  expected: ScenarioStep['expectedEffects']
): void {
  if (!expected) return
  for (const want of expected) {
    const match = produced.find((e) => {
      if (e.kind !== want.kind) return false
      if (!want.payload) return true
      for (const [k, v] of Object.entries(want.payload)) {
        if (JSON.stringify(e.payload[k]) !== JSON.stringify(v)) return false
      }
      return true
    })
    if (!match) {
      failures.push({
        step,
        message: `expected effect kind=${want.kind} payload~=${JSON.stringify(
          want.payload ?? {}
        )} not produced; got ${JSON.stringify(produced.map((e) => ({ kind: e.kind, payload: e.payload })))}`,
      })
    }
  }
}

function publishKernel(workflow: WorkflowDefinition): Kernel {
  const kernel = createInMemoryWorkflowKernel({ now: NOW })
  kernel.publishWorkflowDefinition(workflow)
  return kernel
}

function findObligationByKind(kernel: Kernel, taskId: string, kind: string): ObligationRecord {
  const list = kernel.listObligations(taskId)
  const found = [...list].reverse().find((o) => o.kind === kind && o.status === 'open')
  if (!found) {
    throw new Error(`No open obligation of kind=${kind} for task ${taskId}`)
  }
  return found
}

interface RunReport {
  scenarioId: string
  status: 'pass' | 'fail'
  happyPath: {
    status: 'pass' | 'fail'
    failures: AssertionFailure[]
    lastTask?: WorkflowTask | undefined
  }
  negative: Array<{ name: string; expected: string; got: string; status: 'pass' | 'fail' }>
  effectKindsObserved?: string[]
  obligationFinalStates?: string[]
}

function runHappyPath(
  scenario: Scenario,
  workflow: WorkflowDefinition
): { kernel: Kernel; task: WorkflowTask; failures: AssertionFailure[] } {
  const kernel = publishKernel(workflow)
  const failures: AssertionFailure[] = []

  let pendingEvidence: EvidenceInput[] = []
  let task: WorkflowTask | undefined
  let stepCounter = 0

  for (const step of scenario.steps) {
    stepCounter++
    const idem = `scenario:${scenario.scenarioId}:${step.stepId}:v1`

    if (step.kernel?.op === 'createTask') {
      const args = step.kernel.args
      const created = kernel.createTask({
        taskId: args['taskId'] as string,
        projectId: args['projectId'] as string,
        workflow: args['workflow'] as { id: string; version: number },
        goal: args['goal'] as string,
        risk: args['risk'] as string | undefined,
        initialFacts: args['initialFacts'] as Record<string, unknown> | undefined,
        roleBindings: args['roleBindings'] as Record<string, ActorRef>,
        ...(scenario.supervisor
          ? {
              supervisor: {
                actor: scenario.supervisor.actor,
                autonomy: scenario.supervisor.autonomy,
                capabilities: scenario.supervisor.capabilities,
              },
            }
          : {}),
        idempotencyKey: (args['idempotencyKey'] as string | undefined) ?? idem,
      })
      if (!created.ok) {
        failures.push({ step: step.stepId, message: `createTask rejected: ${created.error.code}` })
        return { kernel, task: task ?? ({} as WorkflowTask), failures }
      }
      task = created.task
      expectState(failures, step.stepId, task, step.expectedStateAfter)
      continue
    }

    if (!task) {
      failures.push({ step: step.stepId, message: 'task not yet created' })
      continue
    }

    // Pure-evidence step: stash for the next transition / control action.
    if (step.evidence && !step.transitionId && !step.controlAction) {
      pendingEvidence.push(...step.evidence)
      // Re-affirm state hasn't changed.
      expectState(failures, step.stepId, task, step.expectedStateAfter)
      continue
    }

    // Transition step.
    if (step.transitionId) {
      const actor = actorByBinding(scenario, step.actorBinding)
      const inlineEvidence = [...pendingEvidence, ...(step.evidence ?? [])]
      pendingEvidence = []
      const result = kernel.applyTransition({
        taskId: task.taskId,
        transitionId: step.transitionId,
        actor,
        role: step.actorBinding,
        expectedTaskVersion: task.version,
        inlineEvidence,
        idempotencyKey: idem,
      })
      if (!result.ok) {
        failures.push({
          step: step.stepId,
          message: `applyTransition(${step.transitionId}) rejected: ${result.error.code} — ${result.error.message}`,
        })
        return { kernel, task, failures }
      }
      task = result.task
      expectState(failures, step.stepId, task, step.expectedStateAfter)
      expectEffects(failures, step.stepId, result.effects, step.expectedEffects)
      continue
    }

    // Control action step (satisfy_obligation, etc).
    if (step.controlAction) {
      const ca = step.controlAction
      const sup = scenario.supervisor
      if (!sup) {
        failures.push({
          step: step.stepId,
          message: 'controlAction step needs scenario.supervisor',
        })
        continue
      }
      let action: WorkflowControlAction
      if (ca.type === 'satisfy_obligation') {
        const obligation = findObligationByKind(kernel, task.taskId, ca.obligationKind ?? '')
        const evidenceForAction = [
          ...pendingEvidence,
          ...(step.evidence ?? []),
          ...(ca.evidence ?? []),
        ]
        pendingEvidence = []
        action = {
          type: 'satisfy_obligation',
          obligationId: obligation.obligationId,
          ...(evidenceForAction.length ? { evidence: evidenceForAction } : {}),
        }
      } else {
        failures.push({
          step: step.stepId,
          message: `unsupported controlAction type: ${ca.type}`,
        })
        continue
      }
      const result: WorkflowResult<{ task: WorkflowTask }> = kernel.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv-1',
        capabilities: sup.capabilities,
        action,
        idempotencyKey: idem,
      })
      if (!result.ok) {
        failures.push({
          step: step.stepId,
          message: `submitControlAction(${ca.type}) rejected: ${result.error.code} — ${result.error.message}`,
        })
        return { kernel, task, failures }
      }
      task = result.task
      expectState(failures, step.stepId, task, step.expectedStateAfter)
      // Folded evidence step may also provide expectedEffects (rare).
      expectEffects(
        failures,
        step.stepId,
        kernel.listEffectIntents(task.taskId).slice(-((step.expectedEffects?.length ?? 0) + 5)),
        step.expectedEffects
      )
      continue
    }

    failures.push({ step: step.stepId, message: 'step has no recognized action' })
  }

  void stepCounter
  return { kernel, task: task as WorkflowTask, failures }
}

interface NegResult {
  name: string
  expected: WorkflowRejectionCode
  got: string
  status: 'pass' | 'fail'
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This independent validation harness keeps each scenario rejection case inline for auditability.
function runNegativeChecks(scenario: Scenario, workflow: WorkflowDefinition): NegResult[] {
  const out: NegResult[] = []

  if (scenario.scenarioId === 'hotfix-implementer-tester') {
    // implementer-actor-cannot-act-as-tester: drive to green, then verify with role=tester but actor=implementer.
    {
      const k = publishKernel(workflow)
      const created = k.createTask({
        taskId: 'neg-hotfix-1',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: {
          implementer: { kind: 'agent', id: 'clod' },
          tester: { kind: 'agent', id: 'cody' },
        },
        idempotencyKey: 'neg-hotfix-1:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      const r1 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'start',
        actor: { kind: 'agent', id: 'clod' },
        role: 'implementer',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'failing_test', ref: 'test:x' }],
        idempotencyKey: 'neg-hotfix-1:start',
      })
      if (!r1.ok) throw new Error(r1.error.message)
      task = r1.task
      const r2 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'implement_fix',
        actor: { kind: 'agent', id: 'clod' },
        role: 'implementer',
        expectedTaskVersion: task.version,
        inlineEvidence: [
          { kind: 'commit_ref', ref: 'git:x' },
          { kind: 'regression_test', ref: 'test:x' },
        ],
        idempotencyKey: 'neg-hotfix-1:fix',
      })
      if (!r2.ok) throw new Error(r2.error.message)
      task = r2.task
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'verify',
        actor: { kind: 'agent', id: 'clod' },
        role: 'tester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'verification_report', ref: 'r:x', summary: 's' }],
        idempotencyKey: 'neg-hotfix-1:verify',
      })
      const got = r3.ok ? 'OK (no rejection)' : r3.error.code
      out.push({
        name: 'implementer-actor-cannot-act-as-tester',
        expected: 'role_not_bound',
        got,
        status: !r3.ok && r3.error.code === 'role_not_bound' ? 'pass' : 'fail',
      })
    }
    // sod-same-actor-both-roles: bind same actor to both, reach green, try verify.
    {
      const k = publishKernel(workflow)
      const sameActor: ActorRef = { kind: 'agent', id: 'clod' }
      const created = k.createTask({
        taskId: 'neg-hotfix-2',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: { implementer: sameActor, tester: sameActor },
        idempotencyKey: 'neg-hotfix-2:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      const r1 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'start',
        actor: sameActor,
        role: 'implementer',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'failing_test', ref: 'test:x' }],
        idempotencyKey: 'neg-hotfix-2:start',
      })
      if (!r1.ok) throw new Error(r1.error.message)
      task = r1.task
      const r2 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'implement_fix',
        actor: sameActor,
        role: 'implementer',
        expectedTaskVersion: task.version,
        inlineEvidence: [
          { kind: 'commit_ref', ref: 'git:x' },
          { kind: 'regression_test', ref: 'test:x' },
        ],
        idempotencyKey: 'neg-hotfix-2:fix',
      })
      if (!r2.ok) throw new Error(r2.error.message)
      task = r2.task
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'verify',
        actor: sameActor,
        role: 'tester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'verification_report', ref: 'r:x', summary: 's' }],
        idempotencyKey: 'neg-hotfix-2:verify',
      })
      const got = r3.ok ? 'OK (no rejection)' : r3.error.code
      out.push({
        name: 'sod-same-actor-both-roles',
        expected: 'sod_violation',
        got,
        status: !r3.ok && r3.error.code === 'sod_violation' ? 'pass' : 'fail',
      })
    }
    // missing-evidence-blocks-fix: skip step 04, try implement_fix.
    {
      const k = publishKernel(workflow)
      const created = k.createTask({
        taskId: 'neg-hotfix-3',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: {
          implementer: { kind: 'agent', id: 'clod' },
          tester: { kind: 'agent', id: 'cody' },
        },
        idempotencyKey: 'neg-hotfix-3:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      const r1 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'start',
        actor: { kind: 'agent', id: 'clod' },
        role: 'implementer',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'failing_test', ref: 'test:x' }],
        idempotencyKey: 'neg-hotfix-3:start',
      })
      if (!r1.ok) throw new Error(r1.error.message)
      task = r1.task
      const r2 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'implement_fix',
        actor: { kind: 'agent', id: 'clod' },
        role: 'implementer',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-hotfix-3:fix',
      })
      const got = r2.ok ? 'OK (no rejection)' : r2.error.code
      out.push({
        name: 'missing-evidence-blocks-fix',
        expected: 'missing_evidence',
        got,
        status: !r2.ok && r2.error.code === 'missing_evidence' ? 'pass' : 'fail',
      })
    }
    return out
  }

  if (scenario.scenarioId === 'support-escalation-customer-response') {
    // resume-without-obligation: skip step 07, attempt resume_resolution from waiting.
    {
      const k = publishKernel(workflow)
      const supportActor: ActorRef = { kind: 'human', id: 'morgan' }
      const created = k.createTask({
        taskId: 'neg-supp-1',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'low',
        roleBindings: { support_agent: supportActor },
        idempotencyKey: 'neg-supp-1:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      const r1 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'start_triage',
        actor: supportActor,
        role: 'support_agent',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'triage_summary', ref: 'd:1', summary: 's' }],
        idempotencyKey: 'neg-supp-1:start',
      })
      if (!r1.ok) throw new Error(r1.error.message)
      task = r1.task
      const r2 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'reach_out',
        actor: supportActor,
        role: 'support_agent',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'customer_outreach_record', ref: 'e:1' }],
        idempotencyKey: 'neg-supp-1:reach',
      })
      if (!r2.ok) throw new Error(r2.error.message)
      task = r2.task
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_customer',
        actor: supportActor,
        role: 'support_agent',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-supp-1:wait',
      })
      if (!r3.ok) throw new Error(r3.error.message)
      task = r3.task
      // Skip satisfy_obligation. Try resume_resolution directly.
      const r4 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resume_resolution',
        actor: supportActor,
        role: 'support_agent',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-supp-1:resume',
      })
      const got = r4.ok ? 'OK (no rejection)' : r4.error.code
      out.push({
        name: 'resume-without-obligation',
        expected: 'obligation_not_satisfied',
        got,
        status: !r4.ok && r4.error.code === 'obligation_not_satisfied' ? 'pass' : 'fail',
      })
    }
    // wait-prevents-direct-resolve: from waiting attempt resolve.
    {
      const k = publishKernel(workflow)
      const supportActor: ActorRef = { kind: 'human', id: 'morgan' }
      const created = k.createTask({
        taskId: 'neg-supp-2',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'low',
        roleBindings: { support_agent: supportActor },
        idempotencyKey: 'neg-supp-2:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      let r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'start_triage',
        actor: supportActor,
        role: 'support_agent',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'triage_summary', ref: 'd:1', summary: 's' }],
        idempotencyKey: 'neg-supp-2:start',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'reach_out',
        actor: supportActor,
        role: 'support_agent',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'customer_outreach_record', ref: 'e:1' }],
        idempotencyKey: 'neg-supp-2:reach',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_customer',
        actor: supportActor,
        role: 'support_agent',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-supp-2:wait',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      const r2 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resolve',
        actor: supportActor,
        role: 'support_agent',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-supp-2:resolve',
      })
      const got = r2.ok ? 'OK (no rejection)' : r2.error.code
      out.push({
        name: 'wait-prevents-direct-resolve',
        expected: 'state_mismatch',
        got,
        status: !r2.ok && r2.error.code === 'state_mismatch' ? 'pass' : 'fail',
      })
    }
    return out
  }

  if (scenario.scenarioId === 'procurement-legal-approval') {
    const requester: ActorRef = { kind: 'human', id: 'alex' }
    const procurement: ActorRef = { kind: 'human', id: 'pat' }
    const legal: ActorRef = { kind: 'human', id: 'robin' }
    const sup = {
      actor: { kind: 'agent', id: 'rex' } as ActorRef,
      autonomy: 'managed' as const,
      capabilities: { satisfyObligations: true, createObligations: true, requestHumanInput: true },
    }

    const driveToFinalApproval = (
      tag: string,
      bindings: Record<string, ActorRef>
    ): { kernel: Kernel; task: WorkflowTask } => {
      const k = publishKernel(workflow)
      const created = k.createTask({
        taskId: `neg-proc-${tag}`,
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: bindings,
        supervisor: sup,
        idempotencyKey: `neg-proc-${tag}:create`,
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      let r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'submit_request',
        actor: bindings['requester'] ?? requester,
        role: 'requester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
        idempotencyKey: `neg-proc-${tag}:submit`,
      })
      if (!r.ok) throw new Error(`submit_request: ${r.error.code}`)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'route_to_vendor',
        actor: bindings['procurement_lead'] ?? procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: `neg-proc-${tag}:route`,
      })
      if (!r.ok) throw new Error(`route_to_vendor: ${r.error.code}`)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_vendor',
        actor: bindings['procurement_lead'] ?? procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: `neg-proc-${tag}:wait`,
      })
      if (!r.ok) throw new Error(`wait_for_vendor: ${r.error.code}`)
      task = r.task
      const vendorObl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
      const sat = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv-neg',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: vendorObl.obligationId,
          evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
        },
        idempotencyKey: `neg-proc-${tag}:sat-vendor`,
      })
      if (!sat.ok) throw new Error(`sat-vendor: ${sat.error.code}`)
      task = sat.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resume_legal_review',
        actor: bindings['legal_reviewer'] ?? legal,
        role: 'legal_reviewer',
        expectedTaskVersion: task.version,
        idempotencyKey: `neg-proc-${tag}:resume-legal`,
      })
      if (!r.ok) throw new Error(`resume_legal_review: ${r.error.code}`)
      task = r.task
      const legalObl = findObligationByKind(k, task.taskId, 'legal_review_pending')
      const sat2 = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv-neg',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: legalObl.obligationId,
          evidence: [{ kind: 'legal_review', ref: 'd:l', summary: 's' }],
        },
        idempotencyKey: `neg-proc-${tag}:sat-legal`,
      })
      if (!sat2.ok) throw new Error(`sat-legal: ${sat2.error.code}`)
      task = sat2.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'complete_legal_review',
        actor: bindings['procurement_lead'] ?? procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: `neg-proc-${tag}:complete-legal`,
      })
      if (!r.ok) throw new Error(`complete_legal_review: ${r.error.code}`)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'approve',
        actor: bindings['procurement_lead'] ?? procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'approval_record', ref: 'd:a', summary: 's' }],
        idempotencyKey: `neg-proc-${tag}:approve-noop`,
      })
      // We don't actually want approve to succeed in negative checks where it should reject; caller handles.
      return { kernel: k, task: r.ok ? r.task : task }
    }

    // approver-cannot-be-requester: bind requester=procurement_lead=alex.
    {
      const k = publishKernel(workflow)
      const aliceBoth: ActorRef = { kind: 'human', id: 'alex' }
      const created = k.createTask({
        taskId: 'neg-proc-approver-eq-requester',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: { requester: aliceBoth, procurement_lead: aliceBoth, legal_reviewer: legal },
        supervisor: sup,
        idempotencyKey: 'neg-proc-aer:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      let r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'submit_request',
        actor: aliceBoth,
        role: 'requester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
        idempotencyKey: 'neg-proc-aer:submit',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'route_to_vendor',
        actor: aliceBoth,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-aer:route',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_vendor',
        actor: aliceBoth,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-aer:wait',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
      const s = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: vobl.obligationId,
          evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
        },
        idempotencyKey: 'neg-proc-aer:satv',
      })
      if (!s.ok) throw new Error(s.error.message)
      task = s.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resume_legal_review',
        actor: legal,
        role: 'legal_reviewer',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-aer:rl',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      const lobl = findObligationByKind(k, task.taskId, 'legal_review_pending')
      const s2 = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: lobl.obligationId,
          evidence: [{ kind: 'legal_review', ref: 'd:l', summary: 's' }],
        },
        idempotencyKey: 'neg-proc-aer:satl',
      })
      if (!s2.ok) throw new Error(s2.error.message)
      task = s2.task
      // complete_legal_review and approve both carry the same SoD requirement; whichever fires first is fine.
      const rcl = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'complete_legal_review',
        actor: aliceBoth,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-aer:cl',
      })
      let firedAt = 'complete_legal_review'
      let firedCode: string = rcl.ok ? 'OK (no rejection)' : rcl.error.code
      if (rcl.ok) {
        task = rcl.task
        const r3 = k.applyTransition({
          taskId: task.taskId,
          transitionId: 'approve',
          actor: aliceBoth,
          role: 'procurement_lead',
          expectedTaskVersion: task.version,
          inlineEvidence: [{ kind: 'approval_record', ref: 'd:a', summary: 's' }],
          idempotencyKey: 'neg-proc-aer:approve',
        })
        firedAt = 'approve'
        firedCode = r3.ok ? 'OK (no rejection)' : r3.error.code
      }
      out.push({
        name: `approver-cannot-be-requester (asserted at ${firedAt} SoD)`,
        expected: 'sod_violation',
        got: firedCode,
        status: firedCode === 'sod_violation' ? 'pass' : 'fail',
      })
    }

    // approver-cannot-be-legal-reviewer: bind procurement_lead = legal_reviewer.
    {
      const k = publishKernel(workflow)
      const both: ActorRef = { kind: 'human', id: 'pat' }
      const created = k.createTask({
        taskId: 'neg-proc-aelr',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: { requester, procurement_lead: both, legal_reviewer: both },
        supervisor: sup,
        idempotencyKey: 'neg-proc-aelr:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      let r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'submit_request',
        actor: requester,
        role: 'requester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
        idempotencyKey: 'neg-proc-aelr:submit',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'route_to_vendor',
        actor: both,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-aelr:route',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_vendor',
        actor: both,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-aelr:wait',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
      const s = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: vobl.obligationId,
          evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
        },
        idempotencyKey: 'neg-proc-aelr:satv',
      })
      if (!s.ok) throw new Error(s.error.message)
      task = s.task
      // resume_legal_review will itself reject because of SoD on resume_legal_review (legal_reviewer not same as procurement_lead).
      // For this check we want to verify approve's sod, so we pivot to using the explicit resume sod check below.
      // But ALSO, this binding pattern triggers `legal-reviewer-cannot-be-procurement-lead` at resume_legal_review.
      // For "approver-cannot-be-legal-reviewer", the kernel will reject earlier at resume_legal_review.
      // So we can only meaningfully assert sod_violation at resume_legal_review here, not at approve.
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resume_legal_review',
        actor: both,
        role: 'legal_reviewer',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-aelr:rl',
      })
      const got = r3.ok ? 'OK (no rejection)' : r3.error.code
      out.push({
        name: 'approver-cannot-be-legal-reviewer (asserted at resume_legal_review SoD)',
        expected: 'sod_violation',
        got,
        status: !r3.ok && r3.error.code === 'sod_violation' ? 'pass' : 'fail',
      })
    }

    // legal-reviewer-cannot-be-requester: bind requester = legal_reviewer.
    {
      const k = publishKernel(workflow)
      const both: ActorRef = { kind: 'human', id: 'alex' }
      const created = k.createTask({
        taskId: 'neg-proc-lrer',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: { requester: both, procurement_lead: procurement, legal_reviewer: both },
        supervisor: sup,
        idempotencyKey: 'neg-proc-lrer:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      let r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'submit_request',
        actor: both,
        role: 'requester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
        idempotencyKey: 'neg-proc-lrer:submit',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'route_to_vendor',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-lrer:route',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_vendor',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-lrer:wait',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
      const s = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: vobl.obligationId,
          evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
        },
        idempotencyKey: 'neg-proc-lrer:satv',
      })
      if (!s.ok) throw new Error(s.error.message)
      task = s.task
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resume_legal_review',
        actor: both,
        role: 'legal_reviewer',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-lrer:rl',
      })
      const got = r3.ok ? 'OK (no rejection)' : r3.error.code
      out.push({
        name: 'legal-reviewer-cannot-be-requester',
        expected: 'sod_violation',
        got,
        status: !r3.ok && r3.error.code === 'sod_violation' ? 'pass' : 'fail',
      })
    }

    // legal-reviewer-cannot-be-procurement-lead: same as the aelr block above, count it again with explicit name.
    {
      const k = publishKernel(workflow)
      const both: ActorRef = { kind: 'human', id: 'pat' }
      const created = k.createTask({
        taskId: 'neg-proc-lrepl',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: { requester, procurement_lead: both, legal_reviewer: both },
        supervisor: sup,
        idempotencyKey: 'neg-proc-lrepl:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      let r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'submit_request',
        actor: requester,
        role: 'requester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
        idempotencyKey: 'neg-proc-lrepl:submit',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'route_to_vendor',
        actor: both,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-lrepl:route',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_vendor',
        actor: both,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-lrepl:wait',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
      const s = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: vobl.obligationId,
          evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
        },
        idempotencyKey: 'neg-proc-lrepl:satv',
      })
      if (!s.ok) throw new Error(s.error.message)
      task = s.task
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resume_legal_review',
        actor: both,
        role: 'legal_reviewer',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-lrepl:rl',
      })
      const got = r3.ok ? 'OK (no rejection)' : r3.error.code
      out.push({
        name: 'legal-reviewer-cannot-be-procurement-lead',
        expected: 'sod_violation',
        got,
        status: !r3.ok && r3.error.code === 'sod_violation' ? 'pass' : 'fail',
      })
    }

    // requester-actor-cannot-act-as-procurement-lead: at final_approval, attempt approve with actor=alex+role=procurement_lead.
    {
      const k = publishKernel(workflow)
      const created = k.createTask({
        taskId: 'neg-proc-racp',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: { requester, procurement_lead: procurement, legal_reviewer: legal },
        supervisor: sup,
        idempotencyKey: 'neg-proc-racp:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      let r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'submit_request',
        actor: requester,
        role: 'requester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
        idempotencyKey: 'neg-proc-racp:submit',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'route_to_vendor',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-racp:route',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_vendor',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-racp:wait',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
      const s = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: vobl.obligationId,
          evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
        },
        idempotencyKey: 'neg-proc-racp:satv',
      })
      if (!s.ok) throw new Error(s.error.message)
      task = s.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resume_legal_review',
        actor: legal,
        role: 'legal_reviewer',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-racp:rl',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      const lobl = findObligationByKind(k, task.taskId, 'legal_review_pending')
      const s2 = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: lobl.obligationId,
          evidence: [{ kind: 'legal_review', ref: 'd:l', summary: 's' }],
        },
        idempotencyKey: 'neg-proc-racp:satl',
      })
      if (!s2.ok) throw new Error(s2.error.message)
      task = s2.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'complete_legal_review',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-racp:cl',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      // Now attempt approve as alex (requester) claiming role=procurement_lead.
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'approve',
        actor: requester,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'approval_record', ref: 'd:a', summary: 's' }],
        idempotencyKey: 'neg-proc-racp:approve',
      })
      const got = r3.ok ? 'OK (no rejection)' : r3.error.code
      out.push({
        name: 'requester-actor-cannot-act-as-procurement-lead',
        expected: 'role_not_bound',
        got,
        status: !r3.ok && r3.error.code === 'role_not_bound' ? 'pass' : 'fail',
      })
    }

    // resume-legal-review-without-vendor: skip step 06.
    {
      const k = publishKernel(workflow)
      const created = k.createTask({
        taskId: 'neg-proc-rlwv',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: { requester, procurement_lead: procurement, legal_reviewer: legal },
        supervisor: sup,
        idempotencyKey: 'neg-proc-rlwv:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      let r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'submit_request',
        actor: requester,
        role: 'requester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
        idempotencyKey: 'neg-proc-rlwv:submit',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'route_to_vendor',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-rlwv:route',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_vendor',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-rlwv:wait',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      // Skip satisfying vendor_response_pending; attempt resume_legal_review.
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resume_legal_review',
        actor: legal,
        role: 'legal_reviewer',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-rlwv:rl',
      })
      const got = r3.ok ? 'OK (no rejection)' : r3.error.code
      out.push({
        name: 'resume-legal-review-without-vendor',
        expected: 'obligation_not_satisfied',
        got,
        status:
          !r3.ok &&
          (r3.error.code === 'obligation_not_satisfied' ||
            r3.error.code === 'open_blocking_obligation')
            ? 'pass'
            : 'fail',
      })
    }

    // complete-legal-without-legal-review: skip legal_review evidence + obligation satisfaction.
    {
      const k = publishKernel(workflow)
      const created = k.createTask({
        taskId: 'neg-proc-clwlr',
        projectId: 'demo',
        workflow: { id: workflow.id, version: workflow.version },
        goal: 'g',
        risk: 'medium',
        roleBindings: { requester, procurement_lead: procurement, legal_reviewer: legal },
        supervisor: sup,
        idempotencyKey: 'neg-proc-clwlr:create',
      })
      if (!created.ok) throw new Error(created.error.message)
      let task = created.task
      let r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'submit_request',
        actor: requester,
        role: 'requester',
        expectedTaskVersion: task.version,
        inlineEvidence: [{ kind: 'request_packet', ref: 'd:1', summary: 's' }],
        idempotencyKey: 'neg-proc-clwlr:submit',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'route_to_vendor',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-clwlr:route',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'wait_for_vendor',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-clwlr:wait',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      const vobl = findObligationByKind(k, task.taskId, 'vendor_response_pending')
      const s = k.submitControlAction({
        taskId: task.taskId,
        supervisorRunId: 'supv',
        capabilities: sup.capabilities,
        action: {
          type: 'satisfy_obligation',
          obligationId: vobl.obligationId,
          evidence: [{ kind: 'vendor_response', ref: 'd:v', summary: 's' }],
        },
        idempotencyKey: 'neg-proc-clwlr:satv',
      })
      if (!s.ok) throw new Error(s.error.message)
      task = s.task
      r = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'resume_legal_review',
        actor: legal,
        role: 'legal_reviewer',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-clwlr:rl',
      })
      if (!r.ok) throw new Error(r.error.message)
      task = r.task
      // Skip satisfying legal_review_pending. Attempt complete_legal_review.
      const r3 = k.applyTransition({
        taskId: task.taskId,
        transitionId: 'complete_legal_review',
        actor: procurement,
        role: 'procurement_lead',
        expectedTaskVersion: task.version,
        idempotencyKey: 'neg-proc-clwlr:cl',
      })
      const got = r3.ok ? 'OK (no rejection)' : r3.error.code
      out.push({
        name: 'complete-legal-without-legal-review',
        expected: 'obligation_not_satisfied',
        got,
        status:
          !r3.ok &&
          (r3.error.code === 'obligation_not_satisfied' ||
            r3.error.code === 'open_blocking_obligation')
            ? 'pass'
            : 'fail',
      })
    }
    // unused helper; suppress.
    void driveToFinalApproval
    return out
  }
  return out
}

function runScenario(scenarioFolder: string): RunReport {
  const folder = join(REPO_ROOT, scenarioFolder)
  const scenario: Scenario = loadJson<Scenario>(join(folder, 'scenario.json'))
  const workflow: WorkflowDefinition = loadJson<WorkflowDefinition>(join(folder, 'workflow.json'))

  const happy = runHappyPath(scenario, workflow)
  const neg = runNegativeChecks(scenario, workflow)

  const happyStatus = happy.failures.length === 0 ? 'pass' : 'fail'
  const negFails = neg.filter((n) => n.status === 'fail').length
  const overall = happyStatus === 'pass' && negFails === 0 ? 'pass' : 'fail'

  const effectKindsObserved = happy.task?.taskId
    ? happy.kernel
        .listEffectIntents(happy.task.taskId)
        .map((e: EffectIntent) => e.kind)
        .sort()
    : []
  const obligationFinalStates = happy.task?.taskId
    ? happy.kernel
        .listObligations(happy.task.taskId)
        .map((o: ObligationRecord) => `${o.kind}=${o.status}`)
    : []

  return {
    scenarioId: scenario.scenarioId,
    status: overall,
    happyPath: { status: happyStatus, failures: happy.failures, lastTask: happy.task },
    negative: neg.map((n) => ({
      name: n.name,
      expected: n.expected,
      got: n.got,
      status: n.status,
    })),
    effectKindsObserved,
    obligationFinalStates,
  }
}

const reports: RunReport[] = []
for (const folder of SCENARIOS) {
  reports.push(runScenario(folder))
}

let allPass = true
for (const r of reports) {
  console.log(`\n=== ${r.scenarioId}: ${r.status.toUpperCase()} ===`)
  console.log(
    `  happy path: ${r.happyPath.status}${
      r.happyPath.failures.length
        ? `\n    failures:\n${r.happyPath.failures.map((f) => `      - [${f.step}] ${f.message}`).join('\n')}`
        : ''
    }`
  )
  if (r.happyPath.lastTask) {
    console.log(
      `    terminal state: status=${r.happyPath.lastTask.state.status} phase=${String(r.happyPath.lastTask.state.phase)} outcome=${String(r.happyPath.lastTask.state.outcome ?? '-')}`
    )
  }
  if (r.effectKindsObserved?.length) {
    console.log(`    effect intents observed: ${r.effectKindsObserved.join(', ')}`)
  }
  if (r.obligationFinalStates?.length) {
    console.log(`    obligation final states: ${r.obligationFinalStates.join(', ')}`)
  }
  console.log('  negative checks:')
  for (const n of r.negative) {
    console.log(
      `    - ${n.status === 'pass' ? 'PASS' : 'FAIL'}  ${n.name}: expected=${n.expected} got=${n.got}`
    )
  }
  if (r.status !== 'pass') allPass = false
}

console.log(`\n>>> OVERALL: ${allPass ? 'SCENARIO-VALIDATION PASS' : 'SCENARIO-VALIDATION FAIL'}`)
process.exit(allPass ? 0 : 1)

void dirname
