import type { AdminStore } from 'acp-admin-store'
import type { JobRecord, JobRunRecord, JobStepRunRecord, JobsStore } from 'acp-jobs-store'

/**
 * ACP-layer job-lifecycle telemetry emitter (T-05245).
 *
 * INVARIANT (per daedalus ruling msg #10821): the ACP jobs store is the sole
 * authority for job-run lifecycle. `systemEvents` is an IMMUTABLE OBSERVER
 * PROJECTION of committed job-run transitions — emission never mutates job state,
 * and a failed/duplicate emit can never roll a run back. This helper is the
 * single emission seam used by every production transition site (scheduler tick
 * results, manual dispatch handler, flow advance, output reconciler). It must NOT
 * live in acp-jobs-store and must NOT make job success depend on Discord.
 *
 * Exactly-once is enforced against the systemEvents store itself
 * (`existsWithPayloadField` on `payload.jobRunId`), so repeated reconciler ticks
 * and process restarts cannot double-emit.
 */

export const JOB_DISPATCHED_EVENT = 'job.dispatched'
export const JOB_COMPLETED_EVENT = 'job.completed'

/** Job-run statuses that represent a committed terminal outcome. */
const TERMINAL_STATUSES = new Set<JobRunRecord['status']>(['succeeded', 'failed'])

export type JobLifecycleEmitter = {
  /**
   * Project lifecycle events for a single job-run transition. Idempotent: safe to
   * call repeatedly with the same run across ticks. `job` may be passed when the
   * caller already has it (avoids a store read); otherwise it is resolved by id.
   */
  reconcile(run: JobRunRecord, job?: JobRecord | undefined): void
}

/** Max chars of captured agent response carried in the job.completed payload.
 * Keeps system_events rows bounded while leaving room for the card to render it
 * (Discord embed description cap is 4096, shared with the subtitle). */
const FINAL_RESPONSE_MAX = 3500

export function createJobLifecycleEmitter(input: {
  systemEvents: AdminStore['systemEvents']
  jobsStore: JobsStore
  now?: (() => Date) | undefined
  /** Optional: resolve the final assistant text for a completed run's HRC run id
   * (see getRunFinalAssistantText). When provided, succeeded job.completed events
   * carry a truncated `finalResponse`. Best-effort — never throws into emission. */
  resolveFinalText?: ((runId: string) => string | undefined) | undefined
}): JobLifecycleEmitter {
  const now = input.now ?? (() => new Date())

  function finalResponseRunId(run: JobRunRecord): string | undefined {
    if (run.runId !== undefined) {
      return run.runId
    }

    try {
      const steps = input.jobsStore.jobStepRuns?.listByJobRun(run.jobRunId).jobStepRuns ?? []
      return latestCompletedStepRunId(steps)
    } catch {
      return undefined
    }
  }

  function captureFinalResponse(run: JobRunRecord): string | undefined {
    const runId = finalResponseRunId(run)
    if (input.resolveFinalText === undefined || runId === undefined) {
      return undefined
    }
    try {
      const text = input.resolveFinalText(runId)
      if (text === undefined) {
        return undefined
      }
      const trimmed = text.trim()
      if (trimmed.length === 0) {
        return undefined
      }
      return trimmed.length > FINAL_RESPONSE_MAX
        ? `${trimmed.slice(0, FINAL_RESPONSE_MAX - 1)}…`
        : trimmed
    } catch {
      return undefined
    }
  }

  function basePayload(run: JobRunRecord, job: JobRecord): Record<string, unknown> {
    return {
      jobId: run.jobId,
      jobRunId: run.jobRunId,
      jobSlug: job.slug,
      agentId: job.agentId,
      projectId: job.projectId,
      // Prefer the resolved snapshot (event/webhook runs) over the live job fields.
      scopeRef: run.resolvedScopeRef ?? job.scopeRef,
      laneRef: run.resolvedLaneRef ?? job.laneRef,
      triggeredBy: run.triggeredBy,
      trigger: job.trigger,
      // Optional identifying/context fields. description is rendered (truncated)
      // on the card today; laneRef/nextFireAt/lastFireAt are carried for future
      // rendering but not shown yet.
      ...(job.description !== undefined ? { description: job.description } : {}),
      ...(job.nextFireAt !== undefined ? { nextFireAt: job.nextFireAt } : {}),
      ...(job.lastFireAt !== undefined ? { lastFireAt: job.lastFireAt } : {}),
      // Optional: flow jobs may have no top-level HRC run (step-level dispatch only).
      ...(run.runId !== undefined ? { runId: run.runId } : {}),
      ...(run.inputAttemptId !== undefined ? { inputAttemptId: run.inputAttemptId } : {}),
      ...(run.triggeredAt !== undefined ? { triggeredAt: run.triggeredAt } : {}),
      ...(run.claimedAt !== undefined ? { claimedAt: run.claimedAt } : {}),
      ...(run.dispatchedAt !== undefined ? { dispatchedAt: run.dispatchedAt } : {}),
    }
  }

  function emitOnce(
    kind: string,
    run: JobRunRecord,
    payload: Record<string, unknown>,
    occurredAt: string
  ): void {
    if (
      input.systemEvents.existsWithPayloadField({
        kind,
        field: 'jobRunId',
        value: run.jobRunId,
      })
    ) {
      return
    }
    input.systemEvents.append({
      projectId: payload['projectId'] as string,
      kind,
      payload,
      occurredAt,
      recordedAt: now().toISOString(),
    })
  }

  function reconcile(run: JobRunRecord, jobMaybe?: JobRecord | undefined): void {
    const job = jobMaybe ?? input.jobsStore.getJob(run.jobId).job
    if (job === undefined) {
      return
    }

    const terminal = TERMINAL_STATUSES.has(run.status)
    // A run has "started" once it is dispatched or has reached a terminal outcome.
    // pending/claimed/skipped are not yet started — no telemetry.
    const started = run.status === 'dispatched' || terminal
    if (!started) {
      return
    }

    const payload = basePayload(run, job)
    // Always ensure the start event exists first. This backfills job.dispatched
    // for synchronous flows that race straight to a terminal status without us
    // ever observing the 'dispatched' state (required test #3).
    emitOnce(JOB_DISPATCHED_EVENT, run, payload, run.dispatchedAt ?? run.triggeredAt)

    if (terminal) {
      // Capture the agent's final response for succeeded runs (carried in the
      // payload; not rendered on the card yet).
      const finalResponse = run.status === 'succeeded' ? captureFinalResponse(run) : undefined
      emitOnce(
        JOB_COMPLETED_EVENT,
        run,
        {
          ...payload,
          status: run.status,
          ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
          ...durationPayload(run),
          ...(run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
          ...(run.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
          ...(finalResponse !== undefined ? { finalResponse } : {}),
        },
        run.completedAt ?? now().toISOString()
      )
    }
  }

  return { reconcile }
}

function durationPayload(run: JobRunRecord): { durationMs?: number } {
  if (run.triggeredAt === undefined || run.completedAt === undefined) {
    return {}
  }
  const triggeredAt = Date.parse(run.triggeredAt)
  const completedAt = Date.parse(run.completedAt)
  if (!Number.isFinite(triggeredAt) || !Number.isFinite(completedAt)) {
    return {}
  }
  const durationMs = completedAt - triggeredAt
  return durationMs >= 0 ? { durationMs } : {}
}

function latestCompletedStepRunId(steps: readonly JobStepRunRecord[]): string | undefined {
  let latest: JobStepRunRecord | undefined
  let latestRunId: string | undefined
  for (const step of steps) {
    const runId = step.runId ?? stringField(step.result, 'runId')
    if (runId === undefined || step.status !== 'succeeded') {
      continue
    }
    if (latest === undefined || stepTimestamp(step) >= stepTimestamp(latest)) {
      latest = step
      latestRunId = runId
    }
  }
  return latestRunId
}

function stepTimestamp(step: JobStepRunRecord): string {
  return step.completedAt ?? step.updatedAt ?? step.createdAt
}

function stringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  const candidate = (value as Record<string, unknown>)[field]
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined
}
