import {
  type JobsStore,
  type NativeStepExecutorDeps,
  executeNativeSideEffectStep,
} from 'acp-jobs-store'
import { createOrFindWrkqTask } from 'wrkq-lib'

import type { ResolvedAcpServerDeps } from '../../deps.js'
import { handleCreateAgentPulpitMessage } from '../../handlers/agent-pulpit-messages.js'
import { createLedgerAgentDispatch } from '../ledger-agent-dispatch.js'
import { resolveNativeStepDef } from './native-step-def.js'
import {
  type StepAdvanceInput,
  type StepAdvanceResult,
  markStepRunning,
  requireJobsStore,
  settleStep,
} from './step-runs.js'

// Native steps (wrkq-task, pulpit-message, agent-dispatch) perform one
// side effect through the jobs-store native executor and settle in place.
export async function advanceNativeStep(input: StepAdvanceInput): Promise<StepAdvanceResult> {
  const jobsStore = requireJobsStore(input.deps)
  const startedStepRun = markStepRunning(input)

  try {
    const { stepDef, resolvedFields } = resolveNativeStepDef({
      jobsStore,
      job: input.job,
      jobRun: input.jobRun,
      phase: input.phase,
      step: input.step,
    })
    await executeNativeSideEffectStep(resolveNativeStepExecutorDeps(input.deps, jobsStore), {
      jobRunId: input.jobRun.jobRunId,
      phase: input.phase,
      stepId: input.step.id,
      attempt: startedStepRun.attempt,
      stepKind: input.step.kind as 'wrkq-task' | 'pulpit-message' | 'agent-dispatch',
      stepDef,
      resolvedFields,
    })

    return settleStep(input, startedStepRun.attempt, { completedAt: input.now })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return settleStep(input, startedStepRun.attempt, {
      status: 'failed',
      error: { code: 'native_step_failed', message },
      completedAt: input.now,
    })
  }
}

function resolveNativeStepExecutorDeps(
  deps: ResolvedAcpServerDeps,
  jobsStore: JobsStore
): NativeStepExecutorDeps {
  if (deps.nativeStepExecutor !== undefined) {
    return { store: jobsStore, ...deps.nativeStepExecutor }
  }
  if (deps.workClient === undefined) {
    throw new Error('native step executor requires a work client')
  }

  const workClient = deps.workClient
  // Attribute flow-created tasks and ledger prompts to the principal ACP's
  // shared client runs as. Stamped per frame: over rpc:// the wrkq proxy did not
  // forward the launch principal, and every create failed "principalRef is
  // required" (T-10378).
  const principalRef = deps.workClientPrincipalRef
  if (principalRef === undefined) {
    throw new Error('native step executor requires the work client principal')
  }

  return {
    store: jobsStore,
    wrkqTaskPort: {
      createOrFind: (input) => createOrFindWrkqTask(workClient, { ...input, principalRef }),
    },
    sendPulpitMessage: async (input) => {
      const response = await handleCreateAgentPulpitMessage({
        request: new Request('http://acp.local/v1/agent-pulpit/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            idempotencyKey: input.idempotencyKey,
            text: input.text,
            ...(input.bindingId !== undefined ? { bindingId: input.bindingId } : {}),
          }),
        }),
        url: new URL('http://acp.local/v1/agent-pulpit/messages'),
        params: {},
        deps,
        actor: deps.defaultActor,
      })
      if (!response.ok) {
        throw new Error(`pulpit message failed with ${response.status}`)
      }
      const payload = (await response.json()) as {
        delivery: { deliveryRequestId: string; bindingId: string }
      }
      return {
        deliveryRequestId: payload.delivery.deliveryRequestId,
        bindingId: payload.delivery.bindingId,
      }
    },
    dispatchAgentInput: createLedgerAgentDispatch(workClient, principalRef),
  }
}
