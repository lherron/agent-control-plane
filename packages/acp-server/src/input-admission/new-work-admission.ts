import type { InputIntent } from 'acp-core'
import { HrcDomainError } from 'hrc-core'
import { forbidden } from '../http.js'
import { causationLaunchEnvFromInputMetadata } from '../jobs/causation-env.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import {
  type AdmissionAttempt,
  type AdmissionRecords,
  admissionResponse,
} from './admission-records.js'
import { admissionStatusForRunStatus } from './admission-status.js'
import { recordInputAdmissionEvent } from './input-admission-events.js'
import type { AdmitInput, InputAdmissionResult } from './input-admission-service.js'
import { type PreparedInputDelivery, metadataWithResolvedAttachments } from './input-delivery.js'
import { RUNTIME_BUSY_REQUEUE_DELAY_MS, isRuntimeBusyError } from './runtime-busy.js'
import {
  findTargetActiveRun,
  isSessionBusy,
  queueDepthExceeded,
  queueFenceFromResetPolicy,
} from './session-admission-policy.js'

export async function admitNewWork(
  records: AdmissionRecords,
  input: AdmitInput,
  intent: Extract<InputIntent, { kind: 'new_work' }>,
  attempt: AdmissionAttempt,
  delivery: PreparedInputDelivery
): Promise<InputAdmissionResult> {
  const deps = records.deps
  const seq = deps.sessionAdmissionSequenceStore.reserve({
    scopeRef: input.sessionRef.scopeRef,
    laneRef: input.sessionRef.laneRef,
  })
  const busy = isSessionBusy(deps, input.sessionRef)
  const resetPolicy = intent.resetPolicy ?? 'follow_latest'
  const activeRunForQueue = findTargetActiveRun(deps, input.sessionRef)
  if (busy && queueDepthExceeded(deps, input.sessionRef.scopeRef, input.sessionRef.laneRef)) {
    return records.createRejectedAdmission({
      attempt,
      intent,
      reason: 'input_queue_depth_exceeded',
    })
  }
  const run = deps.runStore.createRun({
    sessionRef: input.sessionRef,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    actor: input.actor,
    status: busy ? 'queued' : 'pending',
    metadata: {
      content: delivery.content,
      ...(metadataWithResolvedAttachments(input.metadata, delivery.resolvedAttachments) !==
      undefined
        ? {
            meta: metadataWithResolvedAttachments(input.metadata, delivery.resolvedAttachments),
          }
        : {}),
    },
  })
  deps.inputAttemptStore.associateRun(attempt.inputAttempt.inputAttemptId, run.runId)

  if (busy) {
    if (
      deps.authorize(input.actor, 'inputs.queue', {
        kind: 'session',
        id: `${input.sessionRef.scopeRef}/lane:${input.sessionRef.laneRef}`,
      }) === 'deny'
    ) {
      forbidden('authz_deny', 'forbidden')
    }

    const queueItem = deps.inputQueueStore.create({
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      runId: run.runId,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      seq,
      resetPolicy,
      ...queueFenceFromResetPolicy(resetPolicy, activeRunForQueue),
    })
    const currentState = { queueStatus: queueItem.status, seq }
    const admission = deps.inputAdmissionStore.create({
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      admissionKind: 'queued_run',
      intent,
      originalResponse: admissionResponse({
        kind: 'queued_run',
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        runId: run.runId,
        queueItemId: queueItem.queueItemId,
      }),
      currentState,
      runId: run.runId,
      queueItemId: queueItem.queueItemId,
      status: 'queued',
    })
    recordInputAdmissionEvent(deps, {
      eventKind: 'input.queued',
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      admission,
      run,
      queueItem,
    })

    return {
      inputAttempt: attempt.inputAttempt,
      run,
      admission,
      currentState,
      created: true,
    }
  }

  const currentState =
    input.dispatch === false
      ? { runStatus: 'pending', dispatchHeld: true }
      : { runStatus: 'pending' }
  const admission = deps.inputAdmissionStore.create({
    inputAttemptId: attempt.inputAttempt.inputAttemptId,
    admissionKind: 'started_run',
    intent,
    originalResponse: admissionResponse({
      kind: 'started_run',
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      runId: run.runId,
    }),
    currentState,
    runId: run.runId,
    status: 'started',
  })
  recordInputAdmissionEvent(deps, {
    eventKind: 'input.admitted',
    scopeRef: input.sessionRef.scopeRef,
    laneRef: input.sessionRef.laneRef,
    inputAttemptId: attempt.inputAttempt.inputAttemptId,
    admission,
    run,
  })

  if (input.dispatch === false || deps.launchRoleScopedRun === undefined) {
    recordInputAdmissionEvent(deps, {
      eventKind: 'input.started',
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      admission,
      run,
    })
    return {
      inputAttempt: attempt.inputAttempt,
      run,
      admission,
      currentState,
      created: true,
    }
  }

  const causationEnv = causationLaunchEnvFromInputMetadata(input.metadata)
  const launchIntent =
    input.launch?.intent ??
    (await resolveLaunchIntent(deps, input.sessionRef, {
      initialPrompt: input.launch?.initialPrompt ?? delivery.content,
      ...(input.launch?.attachments !== undefined
        ? { attachments: input.launch.attachments }
        : delivery.resolvedAttachments !== undefined
          ? { attachments: delivery.resolvedAttachments }
          : {}),
      ...(causationEnv !== undefined ? { env: causationEnv } : {}),
    }))

  try {
    const launched = await deps.launchRoleScopedRun({
      sessionRef: input.sessionRef,
      intent: launchIntent,
      acpRunId: run.runId,
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      runStore: deps.runStore,
      ...(input.launch?.onEvent !== undefined
        ? { onEvent: input.launch.onEvent }
        : input.launch?.createOnEvent !== undefined
          ? {
              onEvent: input.launch.createOnEvent({
                runId: run.runId,
                inputAttemptId: attempt.inputAttempt.inputAttemptId,
              }),
            }
          : {}),
      ...(input.launch?.waitForCompletion !== undefined
        ? { waitForCompletion: input.launch.waitForCompletion }
        : {}),
    })
    const updatedRun = deps.runStore.getRun(run.runId) ?? run
    const updatedAdmission = deps.inputAdmissionStore.update(attempt.inputAttempt.inputAttemptId, {
      currentState: { runStatus: updatedRun.status },
      status: admissionStatusForRunStatus(updatedRun.status),
    })
    recordInputAdmissionEvent(deps, {
      eventKind: 'input.started',
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      admission: updatedAdmission,
      run: updatedRun,
    })
    return {
      inputAttempt: attempt.inputAttempt,
      run: updatedRun,
      admission: updatedAdmission,
      currentState: updatedAdmission.currentState ?? {},
      created: true,
      launched,
    }
  } catch (error) {
    if (!isRuntimeBusyError(error)) {
      // A non-runtime-busy launch failure must NOT leave the run parked at
      // `pending`. The inline path created the run `pending` (no queue item)
      // before awaiting the launch; if the launch throws, an unfailed pending
      // run becomes a phantom that `sameSessionHasActiveRun` treats as active,
      // jamming every later dispatch in the lane forever (T-04935 — mirrors the
      // queue-dispatcher's own `launch_failed` handling at input-queue-dispatcher
      // catch). Only transition a still-`pending` run; if the launcher already
      // advanced it (hrcRunId + running/terminal), leave the recorded outcome.
      const current = deps.runStore.getRun(run.runId)
      if (current?.status === 'pending') {
        const errorMessage = error instanceof Error ? error.message : String(error)
        const errorCode = error instanceof HrcDomainError ? error.code : 'launch_failed'
        const failedRun = deps.runStore.updateRun(run.runId, {
          status: 'failed',
          errorCode,
          errorMessage,
        })
        const failedAdmission = deps.inputAdmissionStore.update(
          attempt.inputAttempt.inputAttemptId,
          {
            currentState: { runStatus: 'failed', errorCode },
            status: 'failed',
          }
        )
        recordInputAdmissionEvent(deps, {
          eventKind: 'input.started',
          scopeRef: input.sessionRef.scopeRef,
          laneRef: input.sessionRef.laneRef,
          inputAttemptId: attempt.inputAttempt.inputAttemptId,
          admission: failedAdmission,
          run: failedRun,
        })
      }
      throw error
    }

    const queuedRun = deps.runStore.updateRun(run.runId, {
      status: 'queued',
      errorCode: 'runtime_busy',
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    const queueItem = deps.inputQueueStore.create({
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      runId: run.runId,
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      seq,
      resetPolicy,
      ...queueFenceFromResetPolicy(resetPolicy, activeRunForQueue),
      notBeforeAt: new Date(Date.now() + RUNTIME_BUSY_REQUEUE_DELAY_MS).toISOString(),
    })
    const updatedAdmission = deps.inputAdmissionStore.update(attempt.inputAttempt.inputAttemptId, {
      currentState: {
        queueStatus: queueItem.status,
        seq,
        reason: 'runtime_busy',
      },
      status: 'queued',
      queueItemId: queueItem.queueItemId,
    })
    recordInputAdmissionEvent(deps, {
      eventKind: 'input.queued',
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      admission: updatedAdmission,
      run: queuedRun,
      queueItem,
      reason: 'runtime_busy',
    })

    return {
      inputAttempt: attempt.inputAttempt,
      run: queuedRun,
      admission: updatedAdmission,
      currentState: updatedAdmission.currentState ?? {},
      created: true,
    }
  }
}
