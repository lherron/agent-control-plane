import type {
  AttachmentRef,
  InputAdmissionRecord,
  InputApplication,
  InputApplicationStatus,
  InputIntent,
  InputResetPolicy,
  Run,
} from 'acp-core'
import type { SessionRef } from 'agent-scope'
import type { HrcActiveRunContributionResponse, HrcRuntimeIntent } from 'hrc-core'
import type { UnifiedSessionEvent } from 'spaces-runtime'

import { createInterfaceResponseCapture } from '../delivery/interface-response-capture.js'
import type { ResolvedAcpServerDeps } from '../deps.js'
import {
  InMemoryInputAdmissionStore,
  InMemoryInputApplicationStore,
  InMemoryInputQueueStore,
  InMemorySessionAdmissionSequenceStore,
} from '../domain/input-admission-stores.js'
import type { StoredRun } from '../domain/run-store.js'
import { forbidden } from '../http.js'
import { resolveLaunchIntent } from '../launch-role-scoped.js'
import { recordInputAdmissionEvent } from './input-admission-events.js'
import { RUNTIME_BUSY_REQUEUE_DELAY_MS, isRuntimeBusyError } from './runtime-busy.js'

export type InputAdmissionResult = {
  inputAttempt: {
    inputAttemptId: string
    scopeRef: string
    laneRef: string
    taskId?: string | undefined
    idempotencyKey?: string | undefined
    actor: { kind: 'human' | 'agent' | 'system'; id: string; displayName?: string | undefined }
    createdAt: string
    metadata?: Readonly<Record<string, unknown>> | undefined
  }
  run?: StoredRun | undefined
  targetRun?: StoredRun | undefined
  inputApplication?: InputApplication | undefined
  admission: InputAdmissionRecord
  currentState: Readonly<Record<string, unknown>>
  created: boolean
  launched?:
    | {
        runId: string
        sessionId: string
        hostSessionId?: string | undefined
        generation?: number | undefined
      }
    | undefined
}

export type AdmitInput = {
  sessionRef: SessionRef
  taskId?: string | undefined
  idempotencyKey?: string | undefined
  content: string
  actor: { kind: 'human' | 'agent' | 'system'; id: string; displayName?: string | undefined }
  metadata?: Readonly<Record<string, unknown>> | undefined
  intent?: InputIntent | undefined
  dispatch?: boolean | undefined
  launch?: {
    intent?: HrcRuntimeIntent | undefined
    initialPrompt?: string | undefined
    attachments?: AttachmentRef[] | undefined
    onEvent?: ((event: UnifiedSessionEvent) => void | Promise<void>) | undefined
    createOnEvent?:
      | ((input: {
          runId: string
          inputAttemptId: string
        }) => ((event: UnifiedSessionEvent) => void | Promise<void>) | undefined)
      | undefined
    waitForCompletion?: boolean | undefined
  }
}

type AdmissionFallbackStores = Pick<
  ResolvedAcpServerDeps,
  | 'inputAdmissionStore'
  | 'inputApplicationStore'
  | 'inputQueueStore'
  | 'sessionAdmissionSequenceStore'
>

const admissionFallbackStores = new WeakMap<object, AdmissionFallbackStores>()

function getAdmissionFallbackStores(deps: object): AdmissionFallbackStores {
  const existing = admissionFallbackStores.get(deps)
  if (existing !== undefined) {
    return existing
  }

  const stores = {
    inputAdmissionStore: new InMemoryInputAdmissionStore(),
    inputApplicationStore: new InMemoryInputApplicationStore(),
    inputQueueStore: new InMemoryInputQueueStore(),
    sessionAdmissionSequenceStore: new InMemorySessionAdmissionSequenceStore(),
  }
  admissionFallbackStores.set(deps, stores)
  return stores
}

function withAdmissionDefaults(deps: ResolvedAcpServerDeps): ResolvedAcpServerDeps {
  const partial = deps as Partial<ResolvedAcpServerDeps>
  if (
    partial.inputAdmissionStore !== undefined &&
    partial.inputApplicationStore !== undefined &&
    partial.inputQueueStore !== undefined &&
    partial.sessionAdmissionSequenceStore !== undefined &&
    partial.authorize !== undefined
  ) {
    return deps
  }

  const fallbacks = getAdmissionFallbackStores(deps)
  return {
    ...deps,
    inputAdmissionStore: partial.inputAdmissionStore ?? fallbacks.inputAdmissionStore,
    inputApplicationStore: partial.inputApplicationStore ?? fallbacks.inputApplicationStore,
    inputQueueStore: partial.inputQueueStore ?? fallbacks.inputQueueStore,
    sessionAdmissionSequenceStore:
      partial.sessionAdmissionSequenceStore ?? fallbacks.sessionAdmissionSequenceStore,
    authorize: partial.authorize ?? (() => 'allow'),
  }
}

function isSessionBusy(deps: ResolvedAcpServerDeps, sessionRef: SessionRef): boolean {
  const activeRun = deps.runStore
    .listRunsForSession(sessionRef)
    .some((run) => run.status === 'pending' || run.status === 'running')
  if (activeRun) {
    return true
  }

  const head = deps.inputQueueStore.getHead(sessionRef.scopeRef, sessionRef.laneRef)
  return head !== undefined
}

function activeQueueDepth(deps: ResolvedAcpServerDeps, scopeRef: string, laneRef: string): number {
  return deps.inputQueueStore
    .listForSession(scopeRef, laneRef)
    .filter(
      (item) =>
        item.status === 'queued' || item.status === 'leased' || item.status === 'dispatching'
    ).length
}

function queueDepthExceeded(
  deps: ResolvedAcpServerDeps,
  scopeRef: string,
  laneRef: string
): boolean {
  const maxDepth = deps.inputQueuePolicy.maxDepth
  return maxDepth !== undefined && activeQueueDepth(deps, scopeRef, laneRef) >= maxDepth
}

function queueFenceFromResetPolicy(
  resetPolicy: InputResetPolicy,
  activeRun: StoredRun | undefined
): { expectedHostSessionId?: string | undefined; expectedGeneration?: number | undefined } {
  if (resetPolicy === 'follow_latest' || activeRun === undefined) {
    return {}
  }
  return {
    ...(activeRun.hostSessionId !== undefined
      ? { expectedHostSessionId: activeRun.hostSessionId }
      : {}),
    ...(activeRun.generation !== undefined ? { expectedGeneration: activeRun.generation } : {}),
  }
}

function currentStateForAdmission(
  deps: ResolvedAcpServerDeps,
  admission: InputAdmissionRecord
): Readonly<Record<string, unknown>> {
  const state: Record<string, unknown> = {}
  if (admission.runId !== undefined) {
    const run = deps.runStore.getRun(admission.runId)
    if (run !== undefined) {
      state['runStatus'] = run.status
    }
    const queueItem = deps.inputQueueStore.getByRunId(admission.runId)
    if (queueItem !== undefined) {
      state['queueStatus'] = queueItem.status
      state['queueItemId'] = queueItem.queueItemId
      state['seq'] = queueItem.seq
    }
  }
  if (admission.inputApplicationId !== undefined) {
    const application = deps.inputApplicationStore.getById(admission.inputApplicationId)
    if (application !== undefined) {
      state['applicationStatus'] = application.status
      state['inputApplicationId'] = application.inputApplicationId
      if (application.lastErrorCode !== undefined) {
        state['reason'] = application.lastErrorCode
      }
    }
  }

  return state
}

function admissionResponse(input: {
  kind: InputAdmissionRecord['admissionKind']
  inputAttemptId: string
  runId?: string | undefined
  inputApplicationId?: string | undefined
  queueItemId?: string | undefined
  currentState?: Readonly<Record<string, unknown>> | undefined
}): Record<string, unknown> {
  return {
    kind: input.kind,
    inputAttemptId: input.inputAttemptId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.inputApplicationId !== undefined
      ? { inputApplicationId: input.inputApplicationId }
      : {}),
    ...(input.queueItemId !== undefined ? { queueItemId: input.queueItemId } : {}),
    ...(input.currentState !== undefined ? { currentState: input.currentState } : {}),
  }
}

function admissionOperationForIntent(intent: InputIntent): string {
  switch (intent.kind) {
    case 'new_work':
      return 'inputs.create'
    case 'contribute_to_active_run':
      return 'inputs.contribute_active_run'
    case 'control_active_run':
      return 'inputs.control_active_run'
  }
}

function isActiveRun(run: StoredRun): boolean {
  return run.status === 'running' || run.status === 'pending'
}

function findTargetActiveRun(
  deps: ResolvedAcpServerDeps,
  sessionRef: SessionRef
): StoredRun | undefined {
  return deps.runStore.listRunsForSession(sessionRef).filter(isActiveRun).at(-1)
}

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
    return { status: 'ambiguous', errorCode: 'delivery_ambiguous', pendingAdmission: true }
  }
  if (isContributionTransportError(error)) {
    return { status: 'pending', errorCode: 'delivery_transport_error', pendingAdmission: true }
  }
  return { status: 'failed', errorCode: 'delivery_failed', pendingAdmission: false }
}

export class InputAdmissionService {
  private readonly deps: ResolvedAcpServerDeps

  constructor(deps: ResolvedAcpServerDeps) {
    this.deps = withAdmissionDefaults(deps)
  }

  private createRejectedAdmission(input: {
    attempt: ReturnType<ResolvedAcpServerDeps['inputAttemptStore']['createAttempt']>
    intent: InputIntent
    reason: string
    inputApplication?: InputApplication | undefined
  }): InputAdmissionResult {
    const currentState = {
      reason: input.reason,
      ...(input.inputApplication !== undefined
        ? {
            applicationStatus: input.inputApplication.status,
            inputApplicationId: input.inputApplication.inputApplicationId,
          }
        : {}),
    }
    const admission = this.deps.inputAdmissionStore.create({
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admissionKind: 'rejected',
      intent: input.intent,
      originalResponse: admissionResponse({
        kind: 'rejected',
        inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
        ...(input.inputApplication !== undefined
          ? { inputApplicationId: input.inputApplication.inputApplicationId }
          : {}),
      }),
      currentState,
      ...(input.inputApplication !== undefined
        ? { inputApplicationId: input.inputApplication.inputApplicationId }
        : {}),
      status: 'rejected',
    })
    recordInputAdmissionEvent(this.deps, {
      eventKind: 'input.rejected',
      scopeRef: input.attempt.inputAttempt.scopeRef,
      laneRef: input.attempt.inputAttempt.laneRef,
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admission,
      ...(input.inputApplication !== undefined ? { inputApplication: input.inputApplication } : {}),
      reason: input.reason,
    })
    return {
      inputAttempt: input.attempt.inputAttempt,
      ...(input.inputApplication !== undefined ? { inputApplication: input.inputApplication } : {}),
      admission,
      currentState,
      created: input.attempt.created,
    }
  }

  private createQueuedContributionFallback(input: {
    attempt: ReturnType<ResolvedAcpServerDeps['inputAttemptStore']['createAttempt']>
    intent: Extract<InputIntent, { kind: 'contribute_to_active_run' }>
    application: InputApplication
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
      return this.createRejectedAdmission({
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
        inputApplicationId: input.application.inputApplicationId,
        contributionFallback: true,
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

  private createPendingContributionAdmission(input: {
    attempt: ReturnType<ResolvedAcpServerDeps['inputAttemptStore']['createAttempt']>
    intent: Extract<InputIntent, { kind: 'contribute_to_active_run' }>
    application: InputApplication
    reason: string
    targetRun?: StoredRun | undefined
  }): InputAdmissionResult {
    const currentState = {
      applicationStatus: input.application.status,
      inputApplicationId: input.application.inputApplicationId,
      reason: input.reason,
    }
    const admission = this.deps.inputAdmissionStore.create({
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admissionKind: 'admission_pending',
      intent: input.intent,
      originalResponse: admissionResponse({
        kind: 'admission_pending',
        inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
        inputApplicationId: input.application.inputApplicationId,
      }),
      currentState,
      inputApplicationId: input.application.inputApplicationId,
      ...(input.targetRun !== undefined ? { runId: input.targetRun.runId } : {}),
      status: 'pending',
    })
    recordInputAdmissionEvent(this.deps, {
      eventKind: 'input.application.pending',
      scopeRef: input.attempt.inputAttempt.scopeRef,
      laneRef: input.attempt.inputAttempt.laneRef,
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admission,
      ...(input.targetRun !== undefined ? { run: input.targetRun } : {}),
      inputApplication: input.application,
      reason: input.reason,
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

  private createAcceptedContributionAdmission(input: {
    attempt: ReturnType<ResolvedAcpServerDeps['inputAttemptStore']['createAttempt']>
    intent: Extract<InputIntent, { kind: 'contribute_to_active_run' }>
    application: InputApplication
    targetRun?: StoredRun | undefined
  }): InputAdmissionResult {
    const currentState = {
      applicationStatus: input.application.status,
      inputApplicationId: input.application.inputApplicationId,
    }
    const admission = this.deps.inputAdmissionStore.create({
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admissionKind: 'accepted_in_flight',
      intent: input.intent,
      originalResponse: admissionResponse({
        kind: 'accepted_in_flight',
        inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
        inputApplicationId: input.application.inputApplicationId,
      }),
      currentState,
      inputApplicationId: input.application.inputApplicationId,
      ...(input.targetRun !== undefined ? { runId: input.targetRun.runId } : {}),
      status: 'accepted',
    })
    recordInputAdmissionEvent(this.deps, {
      eventKind: 'input.application.accepted',
      scopeRef: input.attempt.inputAttempt.scopeRef,
      laneRef: input.attempt.inputAttempt.laneRef,
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admission,
      ...(input.targetRun !== undefined ? { run: input.targetRun } : {}),
      inputApplication: input.application,
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

  private async admitContribution(
    input: AdmitInput & {
      intent: Extract<InputIntent, { kind: 'contribute_to_active_run' }>
    }
  ): Promise<InputAdmissionResult> {
    const attempt = this.deps.inputAttemptStore.createAttempt({
      sessionRef: input.sessionRef,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      content: input.content,
      actor: input.actor,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    })

    if (!attempt.created) {
      const existingAdmission = this.deps.inputAdmissionStore.getByInputAttemptId(
        attempt.inputAttempt.inputAttemptId
      )
      if (existingAdmission === undefined) {
        throw new Error(
          `input attempt replay has no admission: ${attempt.inputAttempt.inputAttemptId}`
        )
      }
      const run =
        existingAdmission.runId === undefined
          ? undefined
          : this.deps.runStore.getRun(existingAdmission.runId)
      const application =
        existingAdmission.inputApplicationId === undefined
          ? undefined
          : this.deps.inputApplicationStore.getById(existingAdmission.inputApplicationId)
      return {
        inputAttempt: attempt.inputAttempt,
        ...(run !== undefined ? { run } : {}),
        ...(application !== undefined ? { inputApplication: application } : {}),
        admission: existingAdmission,
        currentState:
          existingAdmission.currentState ?? currentStateForAdmission(this.deps, existingAdmission),
        created: false,
      }
    }

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
            reason: 'hrc_client_not_configured',
          })
        : this.createRejectedAdmission({
            attempt,
            intent: input.intent,
            reason: 'hrc_client_not_configured',
            inputApplication: application,
          })
    }

    try {
      const response = await this.deps.hrcClient.submitActiveRunContribution({
        selector: {
          sessionRef: { scopeRef: input.sessionRef.scopeRef, laneRef: input.sessionRef.laneRef },
          ...(targetRun?.hostSessionId !== undefined
            ? { hostSessionId: targetRun.hostSessionId }
            : {}),
          ...(targetRun?.runtimeId !== undefined ? { runtimeId: targetRun.runtimeId } : {}),
        },
        ...(targetRun?.hrcRunId !== undefined ? { expectedRunId: targetRun.hrcRunId } : {}),
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        inputApplicationId: application.inputApplicationId,
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
        prompt: input.content,
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
        return this.createAcceptedContributionAdmission({
          attempt,
          intent: input.intent,
          application,
          ...(targetRun !== undefined ? { targetRun } : {}),
        })
      }
      if (response.status === 'pending') {
        return this.createPendingContributionAdmission({
          attempt,
          intent: input.intent,
          application,
          reason: 'hrc_pending',
          ...(targetRun !== undefined ? { targetRun } : {}),
        })
      }
      if (response.status === 'queue_recommended') {
        if (input.intent.fallback === 'queue') {
          return this.createQueuedContributionFallback({
            attempt,
            intent: input.intent,
            application,
            reason: response.capability?.reason ?? 'active_run_contribution_rejected',
            response,
          })
        }
        return this.createRejectedAdmission({
          attempt,
          intent: input.intent,
          reason: response.capability?.reason ?? 'active_run_contribution_rejected',
          inputApplication: application,
        })
      }
      if (input.intent.fallback === 'queue') {
        return this.createQueuedContributionFallback({
          attempt,
          intent: input.intent,
          application,
          reason: response.errorCode ?? 'active_run_contribution_rejected',
          response,
        })
      }
      return this.createRejectedAdmission({
        attempt,
        intent: input.intent,
        reason: response.errorCode ?? 'active_run_contribution_rejected',
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
        return this.createPendingContributionAdmission({
          attempt,
          intent: input.intent,
          application,
          reason: application.lastErrorCode ?? deliveryError.errorCode,
          ...(targetRun !== undefined ? { targetRun } : {}),
        })
      }
      if (input.intent.fallback === 'queue') {
        return this.createQueuedContributionFallback({
          attempt,
          intent: input.intent,
          application,
          reason: application.lastErrorCode ?? 'delivery_failed',
        })
      }
      return this.createRejectedAdmission({
        attempt,
        intent: input.intent,
        reason: application.lastErrorCode ?? 'delivery_failed',
        inputApplication: application,
      })
    }
  }

  private async admitControl(
    input: AdmitInput & {
      intent: Extract<InputIntent, { kind: 'control_active_run' }>
    }
  ): Promise<InputAdmissionResult> {
    const attempt = this.deps.inputAttemptStore.createAttempt({
      sessionRef: input.sessionRef,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      content: input.content,
      actor: input.actor,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    })

    if (!attempt.created) {
      const existingAdmission = this.deps.inputAdmissionStore.getByInputAttemptId(
        attempt.inputAttempt.inputAttemptId
      )
      if (existingAdmission === undefined) {
        throw new Error(
          `input attempt replay has no admission: ${attempt.inputAttempt.inputAttemptId}`
        )
      }
      return {
        inputAttempt: attempt.inputAttempt,
        admission: existingAdmission,
        currentState: currentStateForAdmission(this.deps, existingAdmission),
        created: false,
      }
    }

    if (this.deps.hrcClient === undefined || input.intent.action === 'pause') {
      return this.createRejectedAdmission({
        attempt,
        intent: input.intent,
        reason:
          input.intent.action === 'pause'
            ? 'control_action_not_supported'
            : 'hrc_client_not_configured',
      })
    }

    const resolved = await this.deps.hrcClient.resolveSession({
      sessionRef: `${input.sessionRef.scopeRef}/lane:${input.sessionRef.laneRef}`,
    })
    if (!resolved.found) {
      return this.createRejectedAdmission({
        attempt,
        intent: input.intent,
        reason: 'runtime_not_found',
      })
    }
    const runtimes = await this.deps.hrcClient.listRuntimes({
      hostSessionId: resolved.hostSessionId,
    })
    const latest = runtimes.at(-1)
    if (latest === undefined) {
      return this.createRejectedAdmission({
        attempt,
        intent: input.intent,
        reason: 'runtime_not_found',
      })
    }

    if (input.intent.action === 'interrupt') {
      await this.deps.hrcClient.interrupt(latest.runtimeId)
    } else {
      await this.deps.hrcClient.terminate(latest.runtimeId)
    }

    const currentState = {
      controlStatus: 'accepted',
      action: input.intent.action,
      runtimeId: latest.runtimeId,
      hostSessionId: latest.hostSessionId,
    }
    const admission = this.deps.inputAdmissionStore.create({
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      admissionKind: 'accepted_in_flight',
      intent: input.intent,
      originalResponse: admissionResponse({
        kind: 'accepted_in_flight',
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        currentState,
      }),
      currentState,
      status: 'accepted',
    })
    recordInputAdmissionEvent(this.deps, {
      eventKind: 'input.application.accepted',
      scopeRef: attempt.inputAttempt.scopeRef,
      laneRef: attempt.inputAttempt.laneRef,
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      admission,
      payload: {
        controlAction: input.intent.action,
        runtimeId: latest.runtimeId,
        hostSessionId: latest.hostSessionId,
      },
    })
    return {
      inputAttempt: attempt.inputAttempt,
      admission,
      currentState,
      created: true,
    }
  }

  async admit(input: AdmitInput): Promise<InputAdmissionResult> {
    const intent = input.intent ?? { kind: 'new_work' as const }
    const operation = admissionOperationForIntent(intent)
    if (
      this.deps.authorize(input.actor, operation, {
        kind: 'session',
        id: `${input.sessionRef.scopeRef}/lane:${input.sessionRef.laneRef}`,
      }) === 'deny'
    ) {
      forbidden('authz_deny', 'forbidden')
    }

    if (intent.kind === 'contribute_to_active_run') {
      return await this.admitContribution({ ...input, intent })
    }

    if (intent.kind === 'control_active_run') {
      return await this.admitControl({ ...input, intent })
    }

    const attempt = this.deps.inputAttemptStore.createAttempt({
      sessionRef: input.sessionRef,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      content: input.content,
      actor: input.actor,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    })

    if (!attempt.created) {
      const existingAdmission = this.deps.inputAdmissionStore.getByInputAttemptId(
        attempt.inputAttempt.inputAttemptId
      )
      if (existingAdmission === undefined) {
        throw new Error(
          `input attempt replay has no admission: ${attempt.inputAttempt.inputAttemptId}`
        )
      }
      const run =
        existingAdmission.runId === undefined
          ? undefined
          : this.deps.runStore.getRun(existingAdmission.runId)
      return {
        inputAttempt: attempt.inputAttempt,
        ...(run !== undefined ? { run } : {}),
        admission: existingAdmission,
        currentState: currentStateForAdmission(this.deps, existingAdmission),
        created: false,
      }
    }

    const seq = this.deps.sessionAdmissionSequenceStore.reserve({
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
    })
    const busy = isSessionBusy(this.deps, input.sessionRef)
    const resetPolicy = intent.resetPolicy ?? 'follow_latest'
    const activeRunForQueue = findTargetActiveRun(this.deps, input.sessionRef)
    if (
      busy &&
      queueDepthExceeded(this.deps, input.sessionRef.scopeRef, input.sessionRef.laneRef)
    ) {
      return this.createRejectedAdmission({
        attempt,
        intent,
        reason: 'input_queue_depth_exceeded',
      })
    }
    const run = this.deps.runStore.createRun({
      sessionRef: input.sessionRef,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      actor: input.actor,
      status: busy ? 'queued' : 'pending',
      metadata: {
        content: input.content,
        ...(input.metadata !== undefined ? { meta: input.metadata } : {}),
      },
    })
    this.deps.inputAttemptStore.associateRun(attempt.inputAttempt.inputAttemptId, run.runId)

    if (busy) {
      if (
        this.deps.authorize(input.actor, 'inputs.queue', {
          kind: 'session',
          id: `${input.sessionRef.scopeRef}/lane:${input.sessionRef.laneRef}`,
        }) === 'deny'
      ) {
        forbidden('authz_deny', 'forbidden')
      }

      const queueItem = this.deps.inputQueueStore.create({
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        runId: run.runId,
        scopeRef: input.sessionRef.scopeRef,
        laneRef: input.sessionRef.laneRef,
        seq,
        resetPolicy,
        ...queueFenceFromResetPolicy(resetPolicy, activeRunForQueue),
      })
      const currentState = { queueStatus: queueItem.status, seq }
      const admission = this.deps.inputAdmissionStore.create({
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
      recordInputAdmissionEvent(this.deps, {
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
    const admission = this.deps.inputAdmissionStore.create({
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
    recordInputAdmissionEvent(this.deps, {
      eventKind: 'input.admitted',
      scopeRef: input.sessionRef.scopeRef,
      laneRef: input.sessionRef.laneRef,
      inputAttemptId: attempt.inputAttempt.inputAttemptId,
      admission,
      run,
    })

    if (input.dispatch === false || this.deps.launchRoleScopedRun === undefined) {
      recordInputAdmissionEvent(this.deps, {
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

    const launchIntent =
      input.launch?.intent ??
      (await resolveLaunchIntent(this.deps, input.sessionRef, {
        initialPrompt: input.launch?.initialPrompt ?? input.content,
        ...(input.launch?.attachments !== undefined
          ? { attachments: input.launch.attachments }
          : {}),
      }))

    try {
      const launched = await this.deps.launchRoleScopedRun({
        sessionRef: input.sessionRef,
        intent: launchIntent,
        acpRunId: run.runId,
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        runStore: this.deps.runStore,
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
      const updatedRun = this.deps.runStore.getRun(run.runId) ?? run
      const updatedAdmission = this.deps.inputAdmissionStore.update(
        attempt.inputAttempt.inputAttemptId,
        {
          currentState: { runStatus: updatedRun.status },
          status: updatedRun.status,
        }
      )
      recordInputAdmissionEvent(this.deps, {
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
        throw error
      }

      const queuedRun = this.deps.runStore.updateRun(run.runId, {
        status: 'queued',
        errorCode: 'runtime_busy',
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      const queueItem = this.deps.inputQueueStore.create({
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        runId: run.runId,
        scopeRef: input.sessionRef.scopeRef,
        laneRef: input.sessionRef.laneRef,
        seq,
        resetPolicy,
        ...queueFenceFromResetPolicy(resetPolicy, activeRunForQueue),
        notBeforeAt: new Date(Date.now() + RUNTIME_BUSY_REQUEUE_DELAY_MS).toISOString(),
      })
      const updatedAdmission = this.deps.inputAdmissionStore.update(
        attempt.inputAttempt.inputAttemptId,
        {
          currentState: {
            queueStatus: queueItem.status,
            seq,
            reason: 'runtime_busy',
          },
          status: 'queued',
          queueItemId: queueItem.queueItemId,
        }
      )
      recordInputAdmissionEvent(this.deps, {
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
}

export function createAdmissionInterfaceCapture(input: {
  deps: ResolvedAcpServerDeps
  runId: string
  inputAttemptId: string
}): { handler: (event: UnifiedSessionEvent) => void | Promise<void> } {
  return createInterfaceResponseCapture({
    interfaceStore: input.deps.interfaceStore,
    runStore: input.deps.runStore,
    runId: input.runId,
    inputAttemptId: input.inputAttemptId,
  })
}

export function runFromAdmissionResult(result: InputAdmissionResult): Run | undefined {
  return result.run
}
