import type { WrkfTransitionApplyParams } from './port.js'
import { type NextActionResponse, projectNextActionResponse } from './projections.js'

const CAS_RETRY_ERROR_CODES = new Set(['WRKF_STALE_REVISION', 'WRKF_CONTEXT_MISMATCH'])

export type TransitionApplyPort = {
  next(params: { task: string; role?: string | undefined }): Promise<unknown>
  transition: {
    apply(params: WrkfTransitionApplyParams): Promise<unknown>
  }
}

export type ApplyFreshTransitionInput = {
  task: string
  transition: string
  role?: string | undefined
  actor?: string | undefined
  routeKey?: string | undefined
  runChecks?: boolean | undefined
  /**
   * When false, skip the pre-apply legality assertion against the fresh next
   * action list (defaults to asserting whenever `role` is set). Use this when
   * the caller has already determined authority and/or the transition is
   * intentionally absent from the public next actions (e.g. PBC dispositions).
   */
  assertLegal?: boolean | undefined
}

export type ApplyFreshTransitionResult = {
  transitionResult: unknown
  instance: {
    revision: number
    contextHash?: string | undefined
  }
}

export async function applyFreshTransition(
  port: TransitionApplyPort,
  input: ApplyFreshTransitionInput
): Promise<ApplyFreshTransitionResult> {
  let fresh = await readNext(port, input)
  let transitionResult: unknown
  let retried = false

  for (;;) {
    // Legality is asserted against the fresh next action list by default, but
    // callers that already computed authority can opt out via assertLegal:false.
    // The PBC product facade does this: it chooses the transition from policy ∩
    // fresh next and applies as product_owner/agent, AND some of its transitions
    // (e.g. dispose_from_*) are intentionally excluded from the public next
    // actions — so a membership check would always false-block them. The final
    // legality ruling is deferred to the runtime in that case.
    if (input.role !== undefined && input.assertLegal !== false) {
      assertLegalTransition(fresh, input.transition)
    }
    try {
      transitionResult = await port.transition.apply(buildApplyParams(input, fresh))
      break
    } catch (error) {
      if (!retried && isCasRetryError(error)) {
        retried = true
        fresh = await readNext(port, input)
        continue
      }
      throw error
    }
  }

  const latest = await readNext(port, input)
  return {
    transitionResult,
    instance: projectResultInstance(latest),
  }
}

async function readNext(
  port: TransitionApplyPort,
  input: ApplyFreshTransitionInput
): Promise<NextActionResponse> {
  return projectNextActionResponse(
    await port.next({
      task: input.task,
      ...(input.role !== undefined ? { role: input.role } : {}),
    })
  )
}

function buildApplyParams(
  input: ApplyFreshTransitionInput,
  fresh: NextActionResponse
): WrkfTransitionApplyParams {
  return {
    task: input.task,
    transition: input.transition,
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    expectRevision: fresh.instance.revision,
    ...(fresh.instance.contextHash !== undefined
      ? { contextHash: fresh.instance.contextHash }
      : {}),
    idempotencyKey: `${input.routeKey ?? input.task}:transition:${input.transition}:${fresh.instance.revision}`,
    ...(input.runChecks !== undefined ? { runChecks: input.runChecks } : {}),
  }
}

function assertLegalTransition(next: NextActionResponse, transition: string): void {
  const legal = next.actions.some((action) => {
    if (action.transition !== transition) {
      return false
    }
    return action.kind === undefined || action.kind === 'transition'
  })

  if (!legal) {
    const error = new Error(`transition is not currently legal: ${transition}`) as Error & {
      code: string
    }
    error.code = 'WRKF_TRANSITION_BLOCKED'
    throw error
  }
}

function projectResultInstance(next: NextActionResponse): ApplyFreshTransitionResult['instance'] {
  return {
    revision: next.instance.revision,
    ...(next.instance.contextHash !== undefined ? { contextHash: next.instance.contextHash } : {}),
  }
}

function isCasRetryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    CAS_RETRY_ERROR_CODES.has((error as { code: string }).code)
  )
}
