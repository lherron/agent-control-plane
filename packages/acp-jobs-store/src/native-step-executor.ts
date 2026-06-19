/**
 * native-step-executor.ts — Native side-effect step executor for the flow engine.
 *
 * Types + stubs: T-04943 Phase B (RED).
 * Implementation: T-04943 Phase B execution.
 *
 * Responsibilities:
 *  - Execute wrkq-task / pulpit-message / agent-dispatch steps.
 *  - Persist structured result_json into job_step_runs.
 *  - Resolve step-output refs from persisted result_json (fail CLOSED).
 *  - Guard terminal (succeeded) steps — never re-execute.
 */

import type { JobStepRunPhase } from 'acp-core'
import { buildHealthIncidentMeta } from './health-incident.js'
import type { JobsStore } from './open-store.js'

// ─── Result types (persisted to job_step_runs.result_json) ─────────────────

export type WrkqTaskStepResult = {
  taskId: string
  projectId: string
  taskPath: string
  created: boolean
}

export type PulpitMessageStepResult = {
  deliveryRequestId: string
  bindingId: string
  idempotencyKey: string
}

export type AgentDispatchStepResult = {
  inputAttemptId: string
  runId: string
  scopeRef: string
  laneRef: string
  idempotencyKey: string
}

export type NativeStepResult =
  | { kind: 'wrkq-task'; result: WrkqTaskStepResult }
  | { kind: 'pulpit-message'; result: PulpitMessageStepResult }
  | { kind: 'agent-dispatch'; result: AgentDispatchStepResult }

// ─── Port interfaces (injected, never raw @wrkq/client here) ───────────────

/** Port for idempotent task create-or-find. */
export type WrkqTaskPort = {
  createOrFind(input: {
    /** Deterministic key: "acp-health:dispatch-timeout:${canonicalEventId}:task" */
    key: string
    /** Deterministic task path: e.g. "agent-control-plane/inbox/acp-health:..." */
    path: string
    /** Project id. */
    projectId: string
    title: string
    description?: string | undefined
  }): Promise<WrkqTaskStepResult>
}

/** Port for sending a pulpit message. */
export type SendPulpitMessage = (input: {
  idempotencyKey: string
  text: string
  bindingId?: string | undefined
}) => Promise<{ deliveryRequestId: string; bindingId: string }>

/** Port for dispatching an agent via /v1/inputs. */
export type DispatchAgentInput = (input: {
  scopeRef: string
  laneRef: string
  idempotencyKey: string
  content: string
  /** Health-incident metadata stamped on the dispatch run. */
  meta?: Readonly<Record<string, unknown>> | undefined
}) => Promise<{ inputAttemptId: string; runId: string }>

/** All ports required by the native step executor. */
export type NativeStepExecutorDeps = {
  store: JobsStore
  wrkqTaskPort: WrkqTaskPort
  sendPulpitMessage: SendPulpitMessage
  dispatchAgentInput: DispatchAgentInput
}

// ─── Step-output ref resolution ────────────────────────────────────────────

/**
 * Resolve a step-output ref from the persisted job_step_runs result_json for
 * the SAME job run (same jobRunId). Reads result[ref.field] and returns the
 * string value. Fails CLOSED (returns undefined) for:
 *   - No row found for the referenced step
 *   - Step status is not 'succeeded'
 *   - result is undefined/null
 *   - Field not present in result
 *   - Field value is not a string (wrong type)
 *
 * No external side effect is produced when returning undefined.
 *
 * NOT YET IMPLEMENTED — throws to keep Phase B tests RED.
 */
export function resolveStepOutputRef(
  store: JobsStore,
  jobRunId: string,
  phase: JobStepRunPhase,
  ref: { $step: string; field: string }
): string | undefined {
  const { jobStepRun } = store.jobStepRuns.getById(jobRunId, phase, ref.$step, 1)
  // Fail CLOSED: no row, not-yet-run / running / failed / cancelled — anything
  // that is not a terminal success — yields no value and no side effect.
  if (jobStepRun === undefined || jobStepRun.status !== 'succeeded') return undefined
  const result = jobStepRun.result
  if (result === undefined || result === null) return undefined
  const val = (result as Record<string, unknown>)[ref.field]
  // Only string-typed leaf fields resolve; nested / wrong-typed / missing fail closed.
  if (typeof val !== 'string') return undefined
  return val
}

// ─── Native step executor ──────────────────────────────────────────────────

/**
 * Execute a native side-effect step (wrkq-task, pulpit-message, agent-dispatch)
 * and persist the structured result_json to job_step_runs.
 *
 * Guards (enforced by implementation):
 *   - Terminal (status=succeeded) step rows must NOT be re-executed.
 *   - result_json is persisted atomically alongside the status=succeeded update.
 *   - Idempotency keys are deterministic (daedalus exact formats).
 *
 * NOT YET IMPLEMENTED — throws to keep Phase B tests RED.
 */
export async function executeNativeSideEffectStep(
  deps: NativeStepExecutorDeps,
  input: {
    jobRunId: string
    phase: JobStepRunPhase
    stepId: string
    attempt: number
    stepKind: 'wrkq-task' | 'pulpit-message' | 'agent-dispatch'
    stepDef: Readonly<Record<string, unknown>>
    /** Pre-resolved values for any StepOutputRef fields. */
    resolvedFields?: Readonly<Record<string, string>> | undefined
  }
): Promise<NativeStepResult> {
  const { store } = deps
  const { jobRunId, phase, stepId, attempt, stepKind, stepDef, resolvedFields } = input

  // ── Terminal-step replay safety ─────────────────────────────────────────
  // A succeeded step row is terminal: return its persisted result and do NOT
  // re-invoke the side-effect port (idempotent crash/scheduler-retry recovery).
  const { jobStepRun: existing } = store.jobStepRuns.getById(jobRunId, phase, stepId, attempt)
  if (
    existing?.status === 'succeeded' &&
    existing.result !== undefined &&
    existing.result !== null
  ) {
    return wrapStepResult(stepKind, existing.result as Record<string, unknown>)
  }

  let result: NativeStepResult

  switch (stepKind) {
    case 'wrkq-task': {
      const canonicalEventId = resolvedFields?.['_canonicalEventId']
      const key = `acp-health:dispatch-timeout:${canonicalEventId}:task`
      const container = asString(stepDef['container']) ?? ''
      const projectId = container.split('/')[0] ?? ''
      const path = `${container}/${key}`
      const taskResult = await deps.wrkqTaskPort.createOrFind({
        key,
        path,
        projectId,
        title: asString(stepDef['title']) ?? '',
        ...(asString(stepDef['description']) !== undefined
          ? { description: asString(stepDef['description']) }
          : {}),
      })
      result = { kind: 'wrkq-task', result: taskResult }
      break
    }

    case 'pulpit-message': {
      const idempotencyKey = `acp-health:dispatch-timeout:${jobRunId}:pulpit`
      const text = asString(stepDef['content']) ?? ''
      const binding = asString(stepDef['binding'])
      const sent = await deps.sendPulpitMessage({
        idempotencyKey,
        text,
        ...(binding !== undefined ? { bindingId: binding } : {}),
      })
      result = {
        kind: 'pulpit-message',
        result: {
          deliveryRequestId: sent.deliveryRequestId,
          bindingId: sent.bindingId,
          idempotencyKey,
        },
      }
      break
    }

    case 'agent-dispatch': {
      const idempotencyKey = `jobrun:${jobRunId}:phase:${phase}:step:${stepId}:attempt:${attempt}`
      const scopeRef = asString(stepDef['scopeRef']) ?? ''
      const laneRef = asString(stepDef['laneRef']) ?? 'main'
      const content = asString(stepDef['content']) ?? ''
      const incidentTaskId = scopeRef.split(':task:')[1] ?? ''
      const sourceEventId = resolvedFields?.['_canonicalEventId'] ?? ''
      const meta = buildHealthIncidentMeta({ jobRunId, sourceEventId, incidentTaskId })
      const dispatched = await deps.dispatchAgentInput({
        scopeRef,
        laneRef,
        idempotencyKey,
        content,
        meta,
      })
      result = {
        kind: 'agent-dispatch',
        result: {
          inputAttemptId: dispatched.inputAttemptId,
          runId: dispatched.runId,
          scopeRef,
          laneRef,
          idempotencyKey,
        },
      }
      break
    }

    default: {
      const exhaustive: never = stepKind
      throw new Error(`executeNativeSideEffectStep: unknown step kind ${String(exhaustive)}`)
    }
  }

  // Persist the structured result_json alongside the terminal succeeded status.
  store.jobStepRuns.updateStep(jobRunId, phase, stepId, attempt, {
    status: 'succeeded',
    result: result.result as Readonly<Record<string, unknown>>,
  })

  return result
}

/** Build a typed NativeStepResult from a persisted result_json record. */
function wrapStepResult(
  stepKind: 'wrkq-task' | 'pulpit-message' | 'agent-dispatch',
  stored: Record<string, unknown>
): NativeStepResult {
  switch (stepKind) {
    case 'wrkq-task':
      return { kind: 'wrkq-task', result: stored as unknown as WrkqTaskStepResult }
    case 'pulpit-message':
      return { kind: 'pulpit-message', result: stored as unknown as PulpitMessageStepResult }
    case 'agent-dispatch':
      return { kind: 'agent-dispatch', result: stored as unknown as AgentDispatchStepResult }
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
