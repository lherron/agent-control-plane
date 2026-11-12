import type {
  ActorRef,
  EffectIntent,
  EvidenceInput,
  WorkflowControlAction,
  WorkflowDefinition,
  WorkflowResult,
  WorkflowTask,
} from '../../packages/acp-core/src/workflow/index.js'
import type { AssertionFailure, Scenario, ScenarioStep } from './contract.js'
import { type Kernel, findObligationByKind, publishKernel } from './kernel-fixture.js'

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

export function runHappyPath(
  scenario: Scenario,
  workflow: WorkflowDefinition
): { kernel: Kernel; task: WorkflowTask; failures: AssertionFailure[] } {
  const kernel = publishKernel(workflow)
  const failures: AssertionFailure[] = []

  let pendingEvidence: EvidenceInput[] = []
  let task: WorkflowTask | undefined

  for (const step of scenario.steps) {
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

  return { kernel, task: task as WorkflowTask, failures }
}
