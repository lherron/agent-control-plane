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
  // TODO: Phase B —
  //   const { jobStepRun } = store.jobStepRuns.getById(jobRunId, phase, ref.$step, 1)
  //   if (jobStepRun === undefined || jobStepRun.status !== 'succeeded') return undefined
  //   if (jobStepRun.result === undefined) return undefined
  //   const val = jobStepRun.result[ref.field]
  //   if (typeof val !== 'string') return undefined
  //   return val
  throw new Error('resolveStepOutputRef: not implemented — T-04943 Phase B')
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
  // TODO: Phase B implementation:
  //   1. Check for existing succeeded step row → terminal guard → return cached result
  //   2. Dispatch to step-kind-specific executor:
  //      wrkq-task: deps.wrkqTaskPort.createOrFind({ key, path, projectId, title, description })
  //      pulpit-message: deps.sendPulpitMessage({ idempotencyKey, text, bindingId })
  //      agent-dispatch: deps.dispatchAgentInput({ scopeRef, laneRef, idempotencyKey, content, meta })
  //   3. Persist result to store.jobStepRuns.updateStep(jobRunId, phase, stepId, attempt, { status: 'succeeded', result })
  //   4. Return NativeStepResult
  throw new Error('executeNativeSideEffectStep: not implemented — T-04943 Phase B')
}
