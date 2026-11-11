import type { InputApplication, InputApplicationStatus, InputIntent } from 'acp-core'
import type { SessionRef } from 'agent-scope'
import type { HrcActiveRunContributionResponse } from 'hrc-core'
import type { ResolvedAcpServerDeps } from '../deps.js'
import type { StoredRun } from '../domain/run-store.js'
import { forbidden } from '../http.js'
import {
  type AdmissionAttempt,
  type AdmissionRecords,
  admissionResponse,
} from './admission-records.js'
import { recordInputAdmissionEvent } from './input-admission-events.js'
import type { AdmitInput, InputAdmissionResult } from './input-admission-service.js'
import { type PreparedInputDelivery, metadataWithResolvedAttachments } from './input-delivery.js'
import { findTargetActiveRun, queueDepthExceeded } from './session-admission-policy.js'

function isContributionAmbiguousError(error: unknown): boolean {
  const candidate = error as Record<string, unknown>
  return (
    candidate?.['name'] === 'TimeoutError' ||
    candidate?.['code'] === 'timeout' ||
    candidate?.['code'] === 'aborted' ||
    candidate?.['errorCode'] === 'timeout' ||
    candidate?.['errorCode'] === 'aborted' ||
    (error instanceof Error && error.message.toLowerCase().includes('timeout')) ||
    (error instanceof Error && error.message.toLowerCase().includes('aborted'))
  )
}

function isContributionTransportError(error: unknown): boolean {
  const candidate = error as Record<string, unknown>
  return candidate?.['code'] === 'transport_error' || candidate?.['errorCode'] === 'transport_error'
}

function classifyContributionDeliveryError(error: unknown): {
  status: InputApplicationStatus
  errorCode: string
  pendingAdmission: boolean
} {
  if (isContributionAmbiguousError(error)) {
    return {
      status: 'ambiguous',
      errorCode: 'delivery_ambiguous',
      pendingAdmission: true,
    }
  }
  if (isContributionTransportError(error)) {
    return {
      status: 'pending',
      errorCode: 'delivery_transport_error',
      pendingAdmission: true,
    }
  }
  return {
    status: 'failed',
    errorCode: 'delivery_failed',
    pendingAdmission: false,
  }
}

export class ActiveRunContributionAdmission {
  private readonly deps: ResolvedAcpServerDeps

  constructor(private readonly records: AdmissionRecords) {
    this.deps = records.deps
  }

  private createQueuedContributionFallback(input: {
    attempt: AdmissionAttempt
    intent: Extract<InputIntent, { kind: 'contribute_to_active_run' }>
    application: InputApplication
    delivery: PreparedInputDelivery
    metadata?: Readonly<Record<string, unknown>> | undefined
    reason: string
    response?: HrcActiveRunContributionResponse | undefined
  }): InputAdmissionResult {
    if (
      this.deps.authorize(input.attempt.inputAttempt.actor, 'inputs.queue', {
        kind: 'session',
        id: `${input.attempt.inputAttempt.scopeRef}/lane:${input.attempt.inputAttempt.laneRef}`,
      }) === 'deny'
    ) {
      forbidden('authz_deny', 'forbidden')
    }

    if (
      queueDepthExceeded(
        this.deps,
        input.attempt.inputAttempt.scopeRef,
        input.attempt.inputAttempt.laneRef
      )
    ) {
      const rejectedApplication = this.deps.inputApplicationStore.update(
        input.application.inputApplicationId,
        {
          status: 'failed',
          lastErrorCode: 'input_queue_depth_exceeded',
          lastErrorMessage: 'input queue max depth exceeded',
        }
      )
      return this.records.createRejectedAdmission({
        attempt: input.attempt,
        intent: input.intent,
        reason: 'input_queue_depth_exceeded',
        inputApplication: rejectedApplication,
      })
    }

    const seq = this.deps.sessionAdmissionSequenceStore.reserve({
      scopeRef: input.attempt.inputAttempt.scopeRef,
      laneRef: input.attempt.inputAttempt.laneRef,
    })
    const run = this.deps.runStore.createRun({
      sessionRef: {
        scopeRef: input.attempt.inputAttempt.scopeRef,
        laneRef: input.attempt.inputAttempt.laneRef as SessionRef['laneRef'],
      },
      ...(input.attempt.inputAttempt.taskId !== undefined
        ? { taskId: input.attempt.inputAttempt.taskId }
        : {}),
      actor: input.attempt.inputAttempt.actor,
      status: 'queued',
      metadata: {
        content: input.delivery.content,
        inputApplicationId: input.application.inputApplicationId,
        contributionFallback: true,
        ...(metadataWithResolvedAttachments(input.metadata, input.delivery.resolvedAttachments) !==
        undefined
          ? {
              meta: metadataWithResolvedAttachments(
                input.metadata,
                input.delivery.resolvedAttachments
              ),
            }
          : {}),
      },
    })
    this.deps.inputAttemptStore.associateRun(input.attempt.inputAttempt.inputAttemptId, run.runId)
    const queueItem = this.deps.inputQueueStore.create({
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      runId: run.runId,
      scopeRef: input.attempt.inputAttempt.scopeRef,
      laneRef: input.attempt.inputAttempt.laneRef,
      seq,
      resetPolicy: 'expire_on_generation_change',
      ...(input.response?.hostSessionId !== undefined
        ? { expectedHostSessionId: input.response.hostSessionId }
        : {}),
      ...(input.response?.generation !== undefined
        ? { expectedGeneration: input.response.generation }
        : {}),
    })
    const currentState = {
      queueStatus: queueItem.status,
      applicationStatus: input.application.status,
      inputApplicationId: input.application.inputApplicationId,
      reason: input.reason,
      seq,
    }
    const admission = this.deps.inputAdmissionStore.create({
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admissionKind: 'queued_run',
      intent: input.intent,
      originalResponse: admissionResponse({
        kind: 'queued_run',
        inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
        inputApplicationId: input.application.inputApplicationId,
        runId: run.runId,
        queueItemId: queueItem.queueItemId,
      }),
      currentState,
      runId: run.runId,
      inputApplicationId: input.application.inputApplicationId,
      queueItemId: queueItem.queueItemId,
      status: 'queued',
    })
    recordInputAdmissionEvent(this.deps, {
      eventKind: 'input.queued',
      scopeRef: input.attempt.inputAttempt.scopeRef,
      laneRef: input.attempt.inputAttempt.laneRef,
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admission,
      run,
      queueItem,
      inputApplication: input.application,
      reason: input.reason,
    })
    return {
      inputAttempt: input.attempt.inputAttempt,
      run,
      inputApplication: input.application,
      admission,
      currentState,
      created: true,
    }
  }

  private createContributionAdmission(input: {
    attempt: AdmissionAttempt
    intent: Extract<InputIntent, { kind: 'contribute_to_active_run' }>
    application: InputApplication
    outcome: { status: 'pending'; reason: string } | { status: 'accepted' }
    targetRun?: StoredRun | undefined
  }): InputAdmissionResult {
    const pending = input.outcome.status === 'pending'
    const kind = pending ? 'admission_pending' : 'accepted_in_flight'
    const currentState = {
      applicationStatus: input.application.status,
      inputApplicationId: input.application.inputApplicationId,
      ...(input.outcome.status === 'pending' ? { reason: input.outcome.reason } : {}),
    }
    const admission = this.deps.inputAdmissionStore.create({
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admissionKind: kind,
      intent: input.intent,
      originalResponse: admissionResponse({
        kind,
        inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
        inputApplicationId: input.application.inputApplicationId,
      }),
      currentState,
      inputApplicationId: input.application.inputApplicationId,
      ...(input.targetRun !== undefined ? { runId: input.targetRun.runId } : {}),
      status: input.outcome.status,
    })
    recordInputAdmissionEvent(this.deps, {
      eventKind: pending ? 'input.application.pending' : 'input.application.accepted',
      scopeRef: input.attempt.inputAttempt.scopeRef,
      laneRef: input.attempt.inputAttempt.laneRef,
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admission,
      ...(input.targetRun !== undefined ? { run: input.targetRun } : {}),
      inputApplication: input.application,
      ...(input.outcome.status === 'pending' ? { reason: input.outcome.reason } : {}),
    })
    return {
      inputAttempt: input.attempt.inputAttempt,
      ...(input.targetRun !== undefined ? { targetRun: input.targetRun } : {}),
      inputApplication: input.application,
      admission,
      currentState,
      created: true,
    }
  }

  async admit(
    input: AdmitInput & {
      intent: Extract<InputIntent, { kind: 'contribute_to_active_run' }>
    },
    attempt: AdmissionAttempt,
    delivery: PreparedInputDelivery
  ): Promise<InputAdmissionResult> {
    const targetRun = findTargetActiveRun(this.deps, input.sessionRef)
    if (targetRun !== undefined) {
      this.deps.inputAttemptStore.associateRun(attempt.inputAttempt.inputAttemptId, targetRun.runId)
    }
    let application = this.deps.inputApplicationStore.create({
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      ...(targetRun !== undefined ? { targetRunId: targetRun.runId } : {}),
      ...(targetRun?.hrcRunId !== undefined ? { hrcRunId: targetRun.hrcRunId } : {}),
      ...(targetRun?.hostSessionId !== undefined ? { hostSessionId: targetRun.hostSessionId } : {}),
      ...(targetRun?.generation !== undefined ? { generation: targetRun.generation } : {}),
      ...(targetRun?.runtimeId !== undefined ? { runtimeId: targetRun.runtimeId } : {}),
      status: 'pending',
    })

    if (this.deps.hrcClient === undefined) {
      application = this.deps.inputApplicationStore.update(application.inputApplicationId, {
        status: 'failed',
        lastErrorCode: 'hrc_client_not_configured',
        lastErrorMessage: 'HRC client is not configured',
      })
      return input.intent.fallback === 'queue'
        ? this.createQueuedContributionFallback({
            attempt,
            intent: input.intent,
            application,
            delivery,
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            reason: 'hrc_client_not_configured',
          })
        : this.records.createRejectedAdmission({
            attempt,
            intent: input.intent,
            reason: 'hrc_client_not_configured',
            inputApplication: application,
          })
    }

    try {
      const response = await this.deps.hrcClient.submitActiveRunContribution({
        selector: {
          sessionRef: {
            scopeRef: input.sessionRef.scopeRef,
            laneRef: input.sessionRef.laneRef,
          },
          ...(targetRun?.hostSessionId !== undefined
            ? { hostSessionId: targetRun.hostSessionId }
            : {}),
          ...(targetRun?.runtimeId !== undefined ? { runtimeId: targetRun.runtimeId } : {}),
        },
        ...(targetRun?.hrcRunId !== undefined ? { expectedRunId: targetRun.hrcRunId } : {}),
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        inputApplicationId: application.inputApplicationId,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        prompt: delivery.content,
        inputType: input.actor.kind === 'human' ? 'human' : 'system',
        semantics: input.intent.contributionSemantics ?? 'append_context',
      })
      application = this.deps.inputApplicationStore.update(application.inputApplicationId, {
        status:
          response.status === 'accepted' || response.status === 'duplicate'
            ? 'accepted'
            : response.status === 'pending'
              ? 'pending'
              : 'failed',
        deliveryAttempts: application.deliveryAttempts + 1,
        ...(response.runId !== undefined ? { hrcRunId: response.runId } : {}),
        ...(response.hostSessionId !== undefined ? { hostSessionId: response.hostSessionId } : {}),
        ...(response.generation !== undefined ? { generation: response.generation } : {}),
        ...(response.runtimeId !== undefined ? { runtimeId: response.runtimeId } : {}),
        ...(response.errorCode !== undefined ? { lastErrorCode: response.errorCode } : {}),
        ...(response.errorMessage !== undefined ? { lastErrorMessage: response.errorMessage } : {}),
      })

      if (response.status === 'accepted' || response.status === 'duplicate') {
        return this.createContributionAdmission({
          outcome: { status: 'accepted' },
          attempt,
          intent: input.intent,
          application,
          ...(targetRun !== undefined ? { targetRun } : {}),
        })
      }
      if (response.status === 'pending') {
        return this.createContributionAdmission({
          attempt,
          intent: input.intent,
          application,
          outcome: { status: 'pending', reason: 'hrc_pending' },
          ...(targetRun !== undefined ? { targetRun } : {}),
        })
      }
      const reason =
        response.status === 'queue_recommended'
          ? (response.capability?.reason ?? 'active_run_contribution_rejected')
          : (response.errorCode ?? 'active_run_contribution_rejected')
      if (input.intent.fallback === 'queue') {
        return this.createQueuedContributionFallback({
          attempt,
          intent: input.intent,
          application,
          delivery,
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          reason,
          response,
        })
      }
      return this.records.createRejectedAdmission({
        attempt,
        intent: input.intent,
        reason,
        inputApplication: application,
      })
    } catch (error) {
      const deliveryError = classifyContributionDeliveryError(error)
      application = this.deps.inputApplicationStore.update(application.inputApplicationId, {
        status: deliveryError.status,
        deliveryAttempts: application.deliveryAttempts + 1,
        lastErrorCode: deliveryError.errorCode,
        lastErrorMessage: error instanceof Error ? error.message : String(error),
      })
      if (deliveryError.pendingAdmission || input.intent.fallback === 'pending_only') {
        return this.createContributionAdmission({
          attempt,
          intent: input.intent,
          application,
          outcome: {
            status: 'pending',
            reason: application.lastErrorCode ?? deliveryError.errorCode,
          },
          ...(targetRun !== undefined ? { targetRun } : {}),
        })
      }
      if (input.intent.fallback === 'queue') {
        return this.createQueuedContributionFallback({
          attempt,
          intent: input.intent,
          application,
          delivery,
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
          reason: application.lastErrorCode ?? 'delivery_failed',
        })
      }
      return this.records.createRejectedAdmission({
        attempt,
        intent: input.intent,
        reason: application.lastErrorCode ?? 'delivery_failed',
        inputApplication: application,
      })
    }
  }
}
