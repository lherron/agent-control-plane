import { writeLogLine } from 'acp-core'
import {
  type JobAdmissionRefusal,
  assertJobExecutionAdmission,
  createJobsScheduler,
} from 'acp-jobs-store'
import type { AcpStateStore } from 'acp-state-store'
import { normalizeSessionRef } from 'agent-scope'
import type { WrkqStoreAdapter } from 'wrkq-lib'
import type { ResolvedAcpServerDeps } from './deps.js'
import { dispatchJobRunThroughInputs } from './handlers/admin-jobs.js'
import { resolveHrcRoutes } from './hrc-client.js'
import { InputAdmissionService } from './input-admission/input-admission-service.js'
import { createInputQueueDispatcher } from './integration/input-queue-dispatcher.js'
import { createInterfaceRunDispatcher } from './integration/interface-run-dispatcher.js'
import { createStaleOrphanReaper } from './integration/stale-orphan-reaper.js'
import { inputQueueDelayMs, jobsDelayMs } from './integration/store-scan-deadlines.js'
import { createStoreScanLoop } from './integration/store-scan-loop.js'
import { createWakeDispatcher } from './integration/wake-dispatcher.js'
import {
  DEFAULT_CAUSATION_DEPTH_LIMIT,
  createEventJobEvaluator,
} from './jobs/event-job-evaluator.js'
import { createUnassignedScheduleReporter } from './jobs/execution-status.js'
import { advanceJobFlow } from './jobs/flow-engine.js'
import { createJobLifecycleEmitter } from './jobs/lifecycle-events.js'
import { formatJobIdentityMissedTickDiagnostic } from './jobs/node-identity.js'
import { createJobOutputReconciler } from './jobs/output-reconciler.js'
import { getRunFinalAssistantText } from './jobs/run-final-output.js'
import { createPbcWorkerRunner } from './pbc/worker-runner.js'
import { createPbcWorkerScheduler } from './pbc/worker-scheduler.js'
import {
  type AcpServerCliOptions,
  DEFAULT_INPUT_QUEUE_LEASE_TIMEOUT_MS,
  DEFAULT_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS,
  DEFAULT_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS,
  isEnabledEnvFlag,
  readPositiveIntegerEnv,
} from './server-config.js'
import type { StoreCommitBus } from './store-commit-bus.js'

const DEFAULT_JOBS_SCHEDULER_INTERVAL_MS = 5_000
const DEFAULT_INTERFACE_DISPATCHER_INTERVAL_MS = 2_000
const DEFAULT_INTERFACE_DISPATCHER_STALE_TIMEOUT_MS = 600_000 // 10 minutes
const DEFAULT_INPUT_QUEUE_DISPATCHER_INTERVAL_MS = 2_000
const EVENT_CAUSATION_DEPTH_LIMIT_ENV = 'ACP_EVENT_CAUSATION_DEPTH_LIMIT'

/** Start background consumers after listeners bind; the runtime owns ordered shutdown. */
export function startServeWorkers(input: {
  resolvedDeps: ResolvedAcpServerDeps
  stateStore: AcpStateStore
  commitBus: StoreCommitBus
  wrkqStore: WrkqStoreAdapter | undefined
  options: AcpServerCliOptions
}) {
  const { resolvedDeps, stateStore, commitBus, wrkqStore, options } = input
  const { coordStore, interfaceStore, jobsStore, conversationStore, jobNodeIdentityAuthority } =
    resolvedDeps

  const wakeDispatcher =
    resolvedDeps.launchRoleScopedRun !== undefined && resolvedDeps.runtimeResolver !== undefined
      ? createWakeDispatcher({
          commitBus,
          coordStore,
          inputAttemptStore: resolvedDeps.inputAttemptStore,
          runStore: resolvedDeps.runStore,
          adminStore: resolvedDeps.adminStore,
          runtimeResolver: resolvedDeps.runtimeResolver,
          ...(resolvedDeps.agentRootResolver !== undefined
            ? { agentRootResolver: resolvedDeps.agentRootResolver }
            : {}),
          launchRoleScopedRun: resolvedDeps.launchRoleScopedRun,
          admitInput: async (input) => {
            const admitted = await new InputAdmissionService(resolvedDeps).admit({
              sessionRef: normalizeSessionRef(input.sessionRef),
              ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
              ...(input.idempotencyKey !== undefined
                ? { idempotencyKey: input.idempotencyKey }
                : {}),
              content: input.content,
              actor: input.actor,
              dispatch: true,
            })
            if (admitted.run === undefined) {
              throw new Error(
                `wake admission did not create a run: ${admitted.inputAttempt.inputAttemptId}`
              )
            }
            return {
              inputAttemptId: admitted.inputAttempt.inputAttemptId,
              runId: admitted.run.runId,
              created: admitted.created,
            }
          },
        })
      : undefined

  if (wakeDispatcher !== undefined) {
    wakeDispatcher.start({ intervalMs: 2_000 })
  }

  const interfaceDispatcherIntervalMs = Number(
    process.env['ACP_INTERFACE_DISPATCHER_INTERVAL_MS'] || DEFAULT_INTERFACE_DISPATCHER_INTERVAL_MS
  )
  const interfaceDispatcherStaleTimeoutMs = Number(
    process.env['ACP_INTERFACE_DISPATCHER_STALE_TIMEOUT_MS'] ||
      DEFAULT_INTERFACE_DISPATCHER_STALE_TIMEOUT_MS
  )
  const interfaceDispatcherDispatchStaleTimeoutMs = Number(
    process.env['ACP_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS'] ||
      DEFAULT_INTERFACE_DISPATCHER_DISPATCH_STALE_TIMEOUT_MS
  )
  // T-13243: launcher evidence, sweeps, the reaper and final output read HRC's routes.
  const hrcRoutes = resolveHrcRoutes(resolvedDeps, 'acp-server:workers')
  const interfaceRunDispatcher =
    resolvedDeps.launchRoleScopedRun !== undefined
      ? createInterfaceRunDispatcher({
          commitBus,
          runStore: resolvedDeps.runStore,
          interfaceStore,
          ...(jobsStore !== undefined ? { jobsStore } : {}),
          conversationStore,
          hrcClient: resolvedDeps.hrcClient,
          hrc: hrcRoutes,
          config: {
            intervalMs: interfaceDispatcherIntervalMs,
            staleTimeoutMs: interfaceDispatcherStaleTimeoutMs,
            dispatchStaleTimeoutMs: interfaceDispatcherDispatchStaleTimeoutMs,
          },
        })
      : undefined

  if (interfaceRunDispatcher !== undefined) {
    interfaceRunDispatcher.start()
  }

  const inputQueueDispatcherIntervalMs = Number(
    process.env['ACP_INPUT_QUEUE_DISPATCHER_INTERVAL_MS'] ||
      DEFAULT_INPUT_QUEUE_DISPATCHER_INTERVAL_MS
  )
  const inputQueueStalePendingRunTimeoutMs = Number(
    process.env['ACP_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS'] ||
      DEFAULT_INPUT_QUEUE_STALE_PENDING_RUN_TIMEOUT_MS
  )
  const inputQueueLeaseTimeoutMs = Number(
    process.env['ACP_INPUT_QUEUE_LEASE_TIMEOUT_MS'] || DEFAULT_INPUT_QUEUE_LEASE_TIMEOUT_MS
  )
  const inputQueueDispatcher =
    resolvedDeps.launchRoleScopedRun !== undefined
      ? createInputQueueDispatcher({
          commitBus,
          reapStaleOrphans: createStaleOrphanReaper({
            sqlite: stateStore.sqlite,
            runStore: resolvedDeps.runStore,
            inputQueueStore: resolvedDeps.inputQueueStore,
            inputAdmissionStore: resolvedDeps.inputAdmissionStore,
            inputApplicationStore: resolvedDeps.inputApplicationStore,
            hrcClient: resolvedDeps.hrcClient,
            hrc: hrcRoutes,
            jobsStore,
            verifyJobNode: async () => {
              const verified = await jobNodeIdentityAuthority?.verifyFresh('scheduler_tick')
              return verified?.ok === true ? verified.identity.nodeId : undefined
            },
          }).runOnce,
          nextDeadlineMs: () =>
            inputQueueDelayMs(stateStore.sqlite, {
              now: Date.now(),
              cadenceMs: inputQueueDispatcherIntervalMs,
              leaseTimeoutMs: inputQueueLeaseTimeoutMs,
              ttlMs: resolvedDeps.inputQueuePolicy.ttlMs,
            }),
          adminStore: resolvedDeps.adminStore,
          hrcClient: resolvedDeps.hrcClient,
          inputAdmissionStore: resolvedDeps.inputAdmissionStore,
          inputQueueStore: resolvedDeps.inputQueueStore,
          ...(jobsStore !== undefined ? { jobsStore } : {}),
          runStore: resolvedDeps.runStore,
          runtimeResolver: resolvedDeps.runtimeResolver,
          inputQueuePolicy: resolvedDeps.inputQueuePolicy,
          launchRoleScopedRun: resolvedDeps.launchRoleScopedRun,
          hrc: hrcRoutes,
          config: {
            intervalMs: inputQueueDispatcherIntervalMs,
            stalePendingRunTimeoutMs: inputQueueStalePendingRunTimeoutMs,
            leaseTimeoutMs: inputQueueLeaseTimeoutMs,
          },
        })
      : undefined

  if (inputQueueDispatcher !== undefined) {
    inputQueueDispatcher.start()
  }

  const schedulerEnabled = isEnabledEnvFlag(process.env['ACP_SCHEDULER_ENABLED'])
  const eventCausationDepthLimit =
    readPositiveIntegerEnv(EVENT_CAUSATION_DEPTH_LIMIT_ENV) ?? DEFAULT_CAUSATION_DEPTH_LIMIT
  const jobsScheduler =
    jobsStore !== undefined && schedulerEnabled
      ? createJobsScheduler({
          store: jobsStore,
          dispatchThroughInputs: (input) => dispatchJobRunThroughInputs(resolvedDeps, input),
          advanceFlowJobRun: (entry) =>
            advanceJobFlow({
              deps: resolvedDeps,
              job: entry.job,
              jobRun: entry.jobRun,
            }),
          evaluateEventJob: createEventJobEvaluator({
            causationDepthLimit: eventCausationDepthLimit,
          }),
          onAdmissionRefused: createUnassignedScheduleReporter({
            log: (line) =>
              writeLogLine({
                level: 'warn',
                component: 'jobs',
                event: 'jobs.schedule.admission_refused',
                data: { message: line },
              }),
          }),
        })
      : undefined
  const jobLifecycleEmitter =
    jobsStore !== undefined
      ? createJobLifecycleEmitter({
          systemEvents: resolvedDeps.adminStore.systemEvents,
          jobsStore,
          resolveFinalText: (runId) =>
            getRunFinalAssistantText(
              {
                getRun: (id) => resolvedDeps.runStore.getRun(id),
                hrc: hrcRoutes,
              },
              runId
            ),
        })
      : undefined
  const jobOutputReconciler =
    jobsStore !== undefined && schedulerEnabled
      ? createJobOutputReconciler({
          jobsStore,
          runStore: resolvedDeps.runStore,
          interfaceStore: resolvedDeps.interfaceStore,
          ...(jobLifecycleEmitter !== undefined
            ? {
                onJobRunSettled: (run, job) => jobLifecycleEmitter.reconcile(run, job),
              }
            : {}),
        })
      : undefined
  const pbcWorkerRunner = schedulerEnabled
    ? createPbcWorkerRunner({ deps: resolvedDeps, wrkqStore, options })
    : undefined
  const pbcWorkerScheduler =
    pbcWorkerRunner !== undefined
      ? createPbcWorkerScheduler({
          stateStore,
          runWorker: pbcWorkerRunner,
        })
      : undefined
  let schedulerNextDelayMs = 60_000
  const schedulerLoop =
    jobsScheduler !== undefined ||
    jobOutputReconciler !== undefined ||
    pbcWorkerScheduler !== undefined
      ? createStoreScanLoop({
          name: 'jobs-pbc-scheduler',
          retryDelayMs: DEFAULT_JOBS_SCHEDULER_INTERVAL_MS,
          bus: commitBus,
          topics: ['jobs', 'runs'],
          nextDelayMs: () => schedulerNextDelayMs,
          scan: async () => {
            await Promise.resolve()
              .then(async () => {
                // The startup identity is only a negative readiness hint. Work still
                // requires verifyFresh below; refused/foreign jobs cannot re-arm
                // an otherwise empty tick forever.
                const diagnostics = jobNodeIdentityAuthority?.getDiagnostics()
                const baseline =
                  diagnostics?.baseline !== undefined && diagnostics.lastVerifiedAt !== undefined
                    ? { ...diagnostics.baseline, verifiedAt: diagnostics.lastVerifiedAt }
                    : undefined
                const jobsReady =
                  jobsStore?.hasSchedulerWork(
                    new Date().toISOString(),
                    baseline,
                    reportReadinessExclusion
                  ) === true
                const verification =
                  jobsReady && (jobsScheduler !== undefined || jobOutputReconciler !== undefined)
                    ? await jobNodeIdentityAuthority?.verifyFresh('scheduler_tick')
                    : undefined
                if (verification !== undefined && !verification.ok) {
                  writeLogLine({
                    level: 'error',
                    component: 'jobs',
                    event: 'jobs.identity_missed_tick',
                    data: {
                      message: formatJobIdentityMissedTickDiagnostic(
                        jobsStore,
                        verification,
                        new Date()
                      ),
                    },
                  })
                  return
                }
                if (jobsScheduler !== undefined && verification?.ok === true) {
                  // tick() returns every job-run it touched this tick (scheduled
                  // dispatch, dispatch_failed, flow advance, flow_advance_failed,
                  // inflight flow re-advance). Project lifecycle telemetry from the
                  // committed results — idempotent, so re-seen inflight runs no-op.
                  const touched = await jobsScheduler.tick(new Date(), verification.identity)
                  if (jobLifecycleEmitter !== undefined) {
                    for (const run of touched) {
                      await jobLifecycleEmitter.reconcile(run)
                    }
                  }
                }
                if (jobOutputReconciler !== undefined && verification?.ok === true) {
                  await jobOutputReconciler.runOnce(verification.identity)
                }
              })
              .catch((error) => {
                writeLogLine({
                  level: 'error',
                  component: 'jobs',
                  event: 'jobs.scheduler_tick_failed',
                  err: error,
                })
              })
              .then(async () => {
                if (pbcWorkerScheduler !== undefined) {
                  await pbcWorkerScheduler.tick()
                }
              })
              .catch((error) => {
                writeLogLine({
                  level: 'error',
                  component: 'pbc',
                  event: 'pbc.worker_scheduler_tick_failed',
                  err: error,
                })
              })
            const now = Date.now()
            const diagnostics = jobNodeIdentityAuthority?.getDiagnostics()
            const identity =
              diagnostics?.baseline !== undefined && diagnostics.lastVerifiedAt !== undefined
                ? { ...diagnostics.baseline, verifiedAt: diagnostics.lastVerifiedAt }
                : undefined
            const scheduleDeadlines =
              jobsStore?.listJobs().jobs.flatMap((job) => {
                if (job.archivedAt !== undefined || job.disabled || job.trigger.kind !== 'schedule')
                  return []
                if (identity !== undefined) {
                  try {
                    assertJobExecutionAdmission(job, identity)
                  } catch {
                    return []
                  }
                }
                return [
                  job.nextFireAt === undefined
                    ? now + DEFAULT_JOBS_SCHEDULER_INTERVAL_MS
                    : Date.parse(job.nextFireAt) > now
                      ? Date.parse(job.nextFireAt)
                      : now + DEFAULT_JOBS_SCHEDULER_INTERVAL_MS,
                ]
              }) ?? []
            schedulerNextDelayMs =
              jobsStore === undefined
                ? 60_000
                : jobsDelayMs(jobsStore.sqlite, {
                    now,
                    cadenceMs: DEFAULT_JOBS_SCHEDULER_INTERVAL_MS,
                    scheduleDeadlines,
                    nodeId: identity?.nodeId,
                  })
            for (const job of [
              ...stateStore.pbcContinuationJobs.listByStatus('queued'),
              ...stateStore.pbcContinuationJobs.listByStatus('running'),
            ]) {
              schedulerNextDelayMs = Math.min(
                schedulerNextDelayMs,
                job.leaseExpiresAt === undefined
                  ? DEFAULT_JOBS_SCHEDULER_INTERVAL_MS
                  : Date.parse(job.leaseExpiresAt) > now
                    ? Date.parse(job.leaseExpiresAt) - now
                    : DEFAULT_JOBS_SCHEDULER_INTERVAL_MS
              )
            }
          },
        })
      : undefined
  schedulerLoop?.start()

  return { wakeDispatcher, interfaceRunDispatcher, inputQueueDispatcher, schedulerLoop }
}

export const reportReadinessExclusion = ({ job, code }: JobAdmissionRefusal): void => {
  writeLogLine({
    level: 'warn',
    component: 'jobs',
    event: 'jobs.schedule.readiness_excluded',
    data: { jobId: job.jobId, slug: job.slug, code, executionNodes: job.executionNodes ?? null },
  })
}
