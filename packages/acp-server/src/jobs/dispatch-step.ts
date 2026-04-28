import type { Actor, JobStepRunPhase } from 'acp-core'

import type { ResolvedAcpServerDeps } from '../deps.js'
import { handleCreateInput } from '../handlers/inputs.js'

// ---------------------------------------------------------------------------
// Pure helper: deterministic idempotency key for a flow step dispatch
// ---------------------------------------------------------------------------

export type StepIdempotencyKeyInput = {
  jobRunId: string
  phase: JobStepRunPhase
  stepId: string
  attempt: number
}

/**
 * Build a deterministic idempotency key for a single flow step dispatch.
 *
 * Format: `jobrun:{jobRunId}:phase:{sequence|onFailure}:step:{stepId}:attempt:{attempt}`
 */
export function buildStepIdempotencyKey(input: StepIdempotencyKeyInput): string {
  return `jobrun:${input.jobRunId}:phase:${input.phase}:step:${input.stepId}:attempt:${input.attempt}`
}

// ---------------------------------------------------------------------------
// Step dispatch helper (mirrors dispatchJobRunThroughInputs for flow steps)
// ---------------------------------------------------------------------------

export type DispatchStepInput = {
  jobId: string
  jobRunId: string
  phase: JobStepRunPhase
  stepId: string
  attempt: number
  scopeRef: string
  laneRef: string
  content: string
  actor?: Actor | undefined
}

/**
 * Dispatch a single flow step through the `/v1/inputs` pipeline.
 *
 * Works identically to the legacy `dispatchJobRunThroughInputs()` but uses a
 * deterministic per-step idempotency key and enriches `meta.source` with step
 * context (`stepId`, `phase`, `attempt`).
 */
export async function dispatchStepThroughInputs(
  deps: ResolvedAcpServerDeps,
  input: DispatchStepInput
): Promise<{ inputAttemptId: string; runId: string }> {
  const actor = input.actor ?? deps.defaultActor
  const idempotencyKey = buildStepIdempotencyKey({
    jobRunId: input.jobRunId,
    phase: input.phase,
    stepId: input.stepId,
    attempt: input.attempt,
  })

  const url = new URL('http://acp.local/v1/inputs')
  const response = await handleCreateInput({
    request: new Request(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionRef: {
          scopeRef: input.scopeRef,
          laneRef: input.laneRef,
        },
        idempotencyKey,
        content: input.content,
        meta: {
          source: {
            kind: 'job',
            jobId: input.jobId,
            jobRunId: input.jobRunId,
            stepId: input.stepId,
            phase: input.phase,
            attempt: input.attempt,
          },
        },
      }),
    }),
    url,
    params: {},
    deps,
    actor,
  })

  if (!response.ok) {
    throw new Error(`step dispatch failed with ${response.status}`)
  }

  const payload = (await response.json()) as {
    inputAttempt: { inputAttemptId: string }
    run: { runId: string }
  }

  return {
    inputAttemptId: payload.inputAttempt.inputAttemptId,
    runId: payload.run.runId,
  }
}
