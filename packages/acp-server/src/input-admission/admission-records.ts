import type { InputAdmissionRecord, InputApplication, InputIntent } from 'acp-core'
import { type SessionRef, formatScopeHandle, parseScopeRef } from 'agent-scope'
import type { CollaborationSayReceipt } from 'wrkq-lib'
import type { ResolvedAcpServerDeps } from '../deps.js'
import {
  InMemoryInputAdmissionStore,
  InMemoryInputApplicationStore,
  InMemoryInputQueueStore,
  InMemorySessionAdmissionSequenceStore,
} from '../domain/input-admission-stores.js'
import { recordInputAdmissionEvent } from './input-admission-events.js'
import type { AdmitInput, InputAdmissionResult } from './input-admission-service.js'

export type AdmissionAttempt = ReturnType<
  ResolvedAcpServerDeps['inputAttemptStore']['createAttempt']
>

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

export function admissionResponse(input: {
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

export class AdmissionRecords {
  readonly deps: ResolvedAcpServerDeps

  constructor(deps: ResolvedAcpServerDeps) {
    this.deps = withAdmissionDefaults(deps)
  }

  replay(attempt: AdmissionAttempt, intent: InputIntent): InputAdmissionResult {
    const admission = this.deps.inputAdmissionStore.getByInputAttemptId(
      attempt.inputAttempt.inputAttemptId
    )
    if (admission === undefined) {
      throw new Error(
        `input attempt replay has no admission: ${attempt.inputAttempt.inputAttemptId}`
      )
    }
    const run =
      intent.kind === 'control_active_run' || admission.runId === undefined
        ? undefined
        : this.deps.runStore.getRun(admission.runId)
    const application =
      intent.kind !== 'contribute_to_active_run' || admission.inputApplicationId === undefined
        ? undefined
        : this.deps.inputApplicationStore.getById(admission.inputApplicationId)
    return {
      inputAttempt: attempt.inputAttempt,
      ...(run !== undefined ? { run } : {}),
      ...(application !== undefined ? { inputApplication: application } : {}),
      admission,
      currentState:
        intent.kind === 'contribute_to_active_run'
          ? (admission.currentState ?? currentStateForAdmission(this.deps, admission))
          : currentStateForAdmission(this.deps, admission),
      created: false,
    }
  }

  async recordHumanCollaborationSay(input: {
    sessionRef: SessionRef
    content: string
    actor: AdmitInput['actor']
    idempotencyKey?: string | undefined
    inputAttemptId: string
  }): Promise<CollaborationSayReceipt | undefined> {
    if (input.actor.kind !== 'human' || this.deps.collaborationLedgerForPrincipal === undefined) {
      return undefined
    }
    const targetScopeHandle = formatScopeHandle(parseScopeRef(input.sessionRef.scopeRef))
    const humanLedger = await this.deps.collaborationLedgerForPrincipal('agent:lance')
    return humanLedger.say({
      ref: targetScopeHandle,
      to: [targetScopeHandle],
      body: input.content,
      idempotencyKey: input.idempotencyKey ?? `acp:input-attempt:${input.inputAttemptId}`,
    })
  }

  createAcceptedCollaborationAdmission(input: {
    attempt: ReturnType<ResolvedAcpServerDeps['inputAttemptStore']['createAttempt']>
    intent: Exclude<InputIntent, { kind: 'control_active_run' }>
    collaboration: CollaborationSayReceipt
  }): InputAdmissionResult {
    const currentState = {
      delivery: 'collaboration_ledger',
      roomUuid: input.collaboration.roomUuid,
      roomKey: input.collaboration.roomKey,
      groupId: input.collaboration.groupId,
      envelopeId: input.collaboration.envelopes[0]?.messageId,
    }
    const admission = this.deps.inputAdmissionStore.create({
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admissionKind: 'accepted_in_flight',
      intent: input.intent,
      originalResponse: admissionResponse({
        kind: 'accepted_in_flight',
        inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
        currentState,
      }),
      currentState,
      status: 'accepted',
    })
    recordInputAdmissionEvent(this.deps, {
      eventKind: 'input.application.accepted',
      scopeRef: input.attempt.inputAttempt.scopeRef,
      laneRef: input.attempt.inputAttempt.laneRef,
      inputAttemptId: input.attempt.inputAttempt.inputAttemptId,
      admission,
      payload: currentState,
    })
    return {
      inputAttempt: input.attempt.inputAttempt,
      admission,
      currentState,
      created: true,
    }
  }

  createRejectedAdmission(input: {
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
}
