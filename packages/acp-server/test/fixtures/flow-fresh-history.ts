import type { Run } from 'acp-core'
import type { JobRunStatus, JobRunTrigger } from 'acp-jobs-store'
import { advanceJobFlow } from '../../src/jobs/flow-engine.js'
import { type FlowEngineDeps, type JobsStore, createFlowJob, createJobRun } from './flow-engine.js'

export function seedPriorStepRun(input: {
  deps: FlowEngineDeps
  jobsStore: JobsStore
  job: ReturnType<typeof createFlowJob>
  jobRunId: string
  stepId: string
  triggeredAt: string
  triggeredBy?: JobRunTrigger | undefined
  phase?: 'sequence' | 'onFailure' | undefined
  stepStatus?: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  jobRunStatus?: JobRunStatus | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  runStatus?: Run['status'] | undefined
  runMetadata?: Readonly<Record<string, unknown>> | undefined
  createRunRecord?: boolean | undefined
}) {
  let runId = input.runId
  if (input.createRunRecord !== false) {
    const run = input.deps.runStore.createRun({
      sessionRef: { scopeRef: input.job.scopeRef, laneRef: input.job.laneRef },
      status: input.runStatus ?? 'completed',
      ...(input.runMetadata !== undefined ? { metadata: input.runMetadata } : {}),
    })
    runId = run.runId
    input.deps.runStore.updateRun(run.runId, {
      status: input.runStatus ?? 'completed',
      hrcRunId: `hrc-${run.runId}`,
      hostSessionId: `hsid-${input.runtimeId ?? run.runId}`,
      ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
    })
  }

  const jobRun = createJobRun(input.jobsStore, input.job.jobId, {
    jobRunId: input.jobRunId,
    triggeredAt: input.triggeredAt,
    triggeredBy: input.triggeredBy ?? 'schedule',
    status: input.jobRunStatus ?? 'succeeded',
    completedAt: '2026-04-28T12:10:00.000Z',
  })
  input.jobsStore.jobStepRuns.insertMany(jobRun.jobRunId, input.phase ?? 'sequence', [
    {
      stepId: input.stepId,
      status: input.stepStatus ?? 'succeeded',
      attempt: 1,
      ...(runId !== undefined ? { runId } : {}),
      startedAt: '2026-04-28T12:00:00.000Z',
      completedAt:
        input.stepStatus === 'pending' || input.stepStatus === 'running'
          ? undefined
          : '2026-04-28T12:05:00.000Z',
    },
  ])

  return { jobRun, runId }
}

export function hrcClientForFreshStep(input: {
  order: string[]
  terminate?: ((runtimeId: string, options: unknown) => Promise<void> | void) | undefined
  terminateCalls?: Array<{ runtimeId: string; options: unknown }> | undefined
  failIfRotated?: boolean | undefined
}) {
  return {
    terminate: async (runtimeId: string, options: unknown) => {
      input.order.push(`terminate:${runtimeId}`)
      input.terminateCalls?.push({ runtimeId, options })
      await input.terminate?.(runtimeId, options)
      return { ok: true, runtimeId, hostSessionId: 'hsid-terminated', droppedContinuation: false }
    },
    resolveSession: async (request: unknown) => {
      if (input.failIfRotated === true) {
        throw new Error('fresh context rotation should not run')
      }
      input.order.push('resolveSession')
      return { found: true, hostSessionId: 'hsid-fresh', request }
    },
    clearContext: async (request: unknown) => {
      if (input.failIfRotated === true) {
        throw new Error('fresh context rotation should not run')
      }
      input.order.push('clearContext')
      return {
        hostSessionId: 'hsid-fresh',
        generation: 2,
        priorHostSessionId: 'hsid-previous',
        request,
      }
    },
  } as never
}

export function scheduledFreshRunMetadata(input: {
  job: ReturnType<typeof createFlowJob>
  stepId?: string | undefined
  phase?: 'sequence' | 'onFailure' | undefined
  freshDuration?: string | undefined
  windowStartedAt: string
}): Readonly<Record<string, unknown>> {
  return {
    scheduledFresh: {
      jobId: input.job.jobId,
      phase: input.phase ?? 'sequence',
      stepId: input.stepId ?? 'fresh-start',
      freshDuration: input.freshDuration ?? 'PT24H',
      windowStartedAt: input.windowStartedAt,
    },
  }
}

export async function advanceScheduledFreshRunWithPriorRuntime(input: {
  deps: FlowEngineDeps
  jobsStore: JobsStore
  order: string[]
  terminate: (runtimeId: string, options: unknown) => Promise<void> | void
  priorRuntimeId?: string | undefined
  currentJobRunId?: string | undefined
}) {
  const job = createFlowJob(input.jobsStore, {
    sequence: [{ id: 'fresh-start', input: 'start with fresh context', fresh: true }],
  })
  const priorRuntimeId = input.priorRuntimeId ?? 'rt-prior'
  seedPriorStepRun({
    deps: input.deps,
    jobsStore: input.jobsStore,
    job,
    jobRunId: `jrun_prior_${priorRuntimeId.replaceAll('-', '_')}`,
    stepId: 'fresh-start',
    triggeredAt: '2026-04-28T12:00:00.000Z',
    runtimeId: priorRuntimeId,
  })
  const jobRun = createJobRun(input.jobsStore, job.jobId, {
    jobRunId: input.currentJobRunId ?? `jrun_current_${priorRuntimeId.replaceAll('-', '_')}`,
    triggeredAt: '2026-04-28T12:20:00.000Z',
    triggeredBy: 'schedule',
    status: 'claimed',
  })

  const advanced = await advanceJobFlow({
    deps: {
      ...input.deps,
      hrcClient: hrcClientForFreshStep({
        order: input.order,
        terminate: input.terminate,
      }),
    } as never,
    job,
    jobRun,
    actor: { kind: 'system', id: 'flow-engine-test' },
    now: '2026-04-28T12:21:00.000Z',
  })

  const stepRun = input.jobsStore.jobStepRuns.getById(
    jobRun.jobRunId,
    'sequence',
    'fresh-start',
    1
  ).jobStepRun
  if (stepRun === undefined) {
    throw new Error('expected current fresh step run')
  }

  return { job, jobRun, advanced, stepRun, priorRuntimeId }
}
