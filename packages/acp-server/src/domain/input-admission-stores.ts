import { randomUUID } from 'node:crypto'

import type {
  InputAdmissionRecord,
  InputApplication,
  InputApplicationStatus,
  InputIntent,
  InputQueueItem,
  InputQueueStatus,
  InputResetPolicy,
} from 'acp-core'
import type { HrcActiveRunContributionResponse } from 'hrc-core'

export type InputAdmissionCreateInput = {
  inputAttemptId: string
  admissionKind: InputAdmissionRecord['admissionKind']
  intent: InputIntent
  originalResponse: Readonly<Record<string, unknown>>
  currentState?: Readonly<Record<string, unknown>> | undefined
  runId?: string | undefined
  inputApplicationId?: string | undefined
  queueItemId?: string | undefined
  status: string
}

export type InputAdmissionUpdateInput = {
  admissionKind?: InputAdmissionRecord['admissionKind'] | undefined
  currentState?: Readonly<Record<string, unknown>> | undefined
  status?: string | undefined
  runId?: string | undefined
  inputApplicationId?: string | undefined
  queueItemId?: string | undefined
}

export interface InputAdmissionStore {
  create(input: InputAdmissionCreateInput): InputAdmissionRecord
  getByInputAttemptId(inputAttemptId: string): InputAdmissionRecord | undefined
  update(inputAttemptId: string, patch: InputAdmissionUpdateInput): InputAdmissionRecord
}

export type InputQueueCreateInput = {
  inputAttemptId: string
  runId: string
  scopeRef: string
  laneRef: string
  seq: number
  status?: InputQueueStatus | undefined
  resetPolicy?: InputResetPolicy | undefined
  expectedHostSessionId?: string | undefined
  expectedGeneration?: number | undefined
  notBeforeAt?: string | undefined
}

export type InputQueueUpdateInput = {
  status?: InputQueueStatus | undefined
  notBeforeAt?: string | undefined
  leasedAt?: string | undefined
  leaseOwner?: string | undefined
  attempts?: number | undefined
  lastErrorCode?: string | undefined
  lastErrorMessage?: string | undefined
}

export interface InputQueueStore {
  create(input: InputQueueCreateInput): InputQueueItem
  getById(queueItemId: string): InputQueueItem | undefined
  getByRunId(runId: string): InputQueueItem | undefined
  getHead(scopeRef: string, laneRef: string): InputQueueItem | undefined
  listDispatchable(limit?: number): readonly InputQueueItem[]
  listForSession(scopeRef: string, laneRef: string): readonly InputQueueItem[]
  update(queueItemId: string, patch: InputQueueUpdateInput): InputQueueItem
}

export interface SessionAdmissionSequenceStore {
  reserve(input: { scopeRef: string; laneRef: string }): number
}

export type InputApplicationCreateInput = {
  inputAttemptId: string
  targetRunId?: string | undefined
  hrcRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  status?: InputApplicationStatus | undefined
}

export type InputApplicationUpdateInput = {
  status?: InputApplicationStatus | undefined
  hrcRunId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  deliveryAttempts?: number | undefined
  lastErrorCode?: string | undefined
  lastErrorMessage?: string | undefined
}

export interface InputApplicationStore {
  create(input: InputApplicationCreateInput): InputApplication
  getById(inputApplicationId: string): InputApplication | undefined
  listPending(): readonly InputApplication[]
  update(inputApplicationId: string, patch: InputApplicationUpdateInput): InputApplication
  reconcileFromHrcLedger(input: {
    inputApplicationId: string
    ledger: HrcActiveRunContributionResponse
    inputAdmissionStore: InputAdmissionStore
  }): {
    inputApplication: InputApplication
    inputAdmission?: InputAdmissionRecord | undefined
  }
}

export class InMemoryInputAdmissionStore implements InputAdmissionStore {
  private readonly records = new Map<string, InputAdmissionRecord>()

  create(input: InputAdmissionCreateInput): InputAdmissionRecord {
    const timestamp = new Date().toISOString()
    const record: InputAdmissionRecord = {
      inputAttemptId: input.inputAttemptId,
      admissionKind: input.admissionKind,
      intent: structuredClone(input.intent),
      originalResponse: structuredClone(input.originalResponse),
      ...(input.currentState !== undefined ? { currentState: input.currentState } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      ...(input.inputApplicationId !== undefined
        ? { inputApplicationId: input.inputApplicationId }
        : {}),
      ...(input.queueItemId !== undefined ? { queueItemId: input.queueItemId } : {}),
      status: input.status,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.records.set(record.inputAttemptId, record)
    return structuredClone(record)
  }

  getByInputAttemptId(inputAttemptId: string): InputAdmissionRecord | undefined {
    const record = this.records.get(inputAttemptId)
    return record === undefined ? undefined : structuredClone(record)
  }

  update(inputAttemptId: string, patch: InputAdmissionUpdateInput): InputAdmissionRecord {
    const current = this.records.get(inputAttemptId)
    if (current === undefined) {
      throw new Error(`input admission not found: ${inputAttemptId}`)
    }
    const next: InputAdmissionRecord = {
      ...current,
      admissionKind: patch.admissionKind ?? current.admissionKind,
      ...(patch.currentState !== undefined ? { currentState: patch.currentState } : {}),
      ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
      ...(patch.inputApplicationId !== undefined
        ? { inputApplicationId: patch.inputApplicationId }
        : {}),
      ...(patch.queueItemId !== undefined ? { queueItemId: patch.queueItemId } : {}),
      status: patch.status ?? current.status,
      updatedAt: new Date().toISOString(),
    }
    this.records.set(inputAttemptId, next)
    return structuredClone(next)
  }
}

export class InMemorySessionAdmissionSequenceStore implements SessionAdmissionSequenceStore {
  private readonly nextBySession = new Map<string, number>()

  reserve(input: { scopeRef: string; laneRef: string }): number {
    const key = `${input.scopeRef}\u0000${input.laneRef}`
    const seq = this.nextBySession.get(key) ?? 1
    this.nextBySession.set(key, seq + 1)
    return seq
  }
}

export class InMemoryInputQueueStore implements InputQueueStore {
  private readonly items = new Map<string, InputQueueItem>()

  create(input: InputQueueCreateInput): InputQueueItem {
    const timestamp = new Date().toISOString()
    const item: InputQueueItem = {
      queueItemId: `iq_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      inputAttemptId: input.inputAttemptId,
      runId: input.runId,
      scopeRef: input.scopeRef,
      laneRef: input.laneRef,
      seq: input.seq,
      status: input.status ?? 'queued',
      resetPolicy: input.resetPolicy ?? 'follow_latest',
      ...(input.expectedHostSessionId !== undefined
        ? { expectedHostSessionId: input.expectedHostSessionId }
        : {}),
      ...(input.expectedGeneration !== undefined
        ? { expectedGeneration: input.expectedGeneration }
        : {}),
      ...(input.notBeforeAt !== undefined ? { notBeforeAt: input.notBeforeAt } : {}),
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.items.set(item.queueItemId, item)
    return structuredClone(item)
  }

  getById(queueItemId: string): InputQueueItem | undefined {
    const item = this.items.get(queueItemId)
    return item === undefined ? undefined : structuredClone(item)
  }

  getByRunId(runId: string): InputQueueItem | undefined {
    return this.listAll().find((item) => item.runId === runId)
  }

  getHead(scopeRef: string, laneRef: string): InputQueueItem | undefined {
    return this.listAll()
      .filter(
        (item) =>
          item.scopeRef === scopeRef &&
          item.laneRef === laneRef &&
          (item.status === 'queued' || item.status === 'leased' || item.status === 'dispatching')
      )
      .sort((left, right) => left.seq - right.seq)[0]
  }

  listDispatchable(limit = 50): readonly InputQueueItem[] {
    const now = new Date().toISOString()
    return this.listAll()
      .filter(
        (item) =>
          item.status === 'queued' && (item.notBeforeAt === undefined || item.notBeforeAt <= now)
      )
      .sort((left, right) =>
        left.scopeRef === right.scopeRef
          ? left.laneRef === right.laneRef
            ? left.seq - right.seq
            : left.laneRef.localeCompare(right.laneRef)
          : left.scopeRef.localeCompare(right.scopeRef)
      )
      .slice(0, limit)
  }

  listForSession(scopeRef: string, laneRef: string): readonly InputQueueItem[] {
    return this.listAll()
      .filter((item) => item.scopeRef === scopeRef && item.laneRef === laneRef)
      .sort((left, right) => left.seq - right.seq)
  }

  update(queueItemId: string, patch: InputQueueUpdateInput): InputQueueItem {
    const current = this.items.get(queueItemId)
    if (current === undefined) {
      throw new Error(`input queue item not found: ${queueItemId}`)
    }
    const next: InputQueueItem = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.notBeforeAt !== undefined ? { notBeforeAt: patch.notBeforeAt } : {}),
      ...(patch.leasedAt !== undefined ? { leasedAt: patch.leasedAt } : {}),
      ...(patch.leaseOwner !== undefined ? { leaseOwner: patch.leaseOwner } : {}),
      attempts: patch.attempts ?? current.attempts,
      ...(patch.lastErrorCode !== undefined ? { lastErrorCode: patch.lastErrorCode } : {}),
      ...(patch.lastErrorMessage !== undefined ? { lastErrorMessage: patch.lastErrorMessage } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.items.set(queueItemId, next)
    return structuredClone(next)
  }

  private listAll(): InputQueueItem[] {
    return [...this.items.values()].map((item) => structuredClone(item))
  }
}

export class InMemoryInputApplicationStore implements InputApplicationStore {
  private readonly applications = new Map<string, InputApplication>()

  create(input: InputApplicationCreateInput): InputApplication {
    const timestamp = new Date().toISOString()
    const application: InputApplication = {
      inputApplicationId: `iap_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      inputAttemptId: input.inputAttemptId,
      ...(input.targetRunId !== undefined ? { targetRunId: input.targetRunId } : {}),
      ...(input.hrcRunId !== undefined ? { hrcRunId: input.hrcRunId } : {}),
      ...(input.hostSessionId !== undefined ? { hostSessionId: input.hostSessionId } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      ...(input.runtimeId !== undefined ? { runtimeId: input.runtimeId } : {}),
      status: input.status ?? 'pending',
      deliveryAttempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.applications.set(application.inputApplicationId, application)
    return structuredClone(application)
  }

  getById(inputApplicationId: string): InputApplication | undefined {
    const application = this.applications.get(inputApplicationId)
    return application === undefined ? undefined : structuredClone(application)
  }

  listPending(): readonly InputApplication[] {
    return [...this.applications.values()]
      .filter((application) => application.status === 'pending')
      .map((application) => structuredClone(application))
  }

  update(inputApplicationId: string, patch: InputApplicationUpdateInput): InputApplication {
    const current = this.applications.get(inputApplicationId)
    if (current === undefined) {
      throw new Error(`input application not found: ${inputApplicationId}`)
    }
    const next: InputApplication = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.hrcRunId !== undefined ? { hrcRunId: patch.hrcRunId } : {}),
      ...(patch.hostSessionId !== undefined ? { hostSessionId: patch.hostSessionId } : {}),
      ...(patch.generation !== undefined ? { generation: patch.generation } : {}),
      ...(patch.runtimeId !== undefined ? { runtimeId: patch.runtimeId } : {}),
      deliveryAttempts: patch.deliveryAttempts ?? current.deliveryAttempts,
      ...(patch.lastErrorCode !== undefined ? { lastErrorCode: patch.lastErrorCode } : {}),
      ...(patch.lastErrorMessage !== undefined ? { lastErrorMessage: patch.lastErrorMessage } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.applications.set(inputApplicationId, next)
    return structuredClone(next)
  }

  reconcileFromHrcLedger(input: {
    inputApplicationId: string
    ledger: HrcActiveRunContributionResponse
    inputAdmissionStore: InputAdmissionStore
  }): {
    inputApplication: InputApplication
    inputAdmission?: InputAdmissionRecord | undefined
  } {
    return reconcileInputApplicationFromHrcLedger({
      inputApplicationStore: this,
      inputAdmissionStore: input.inputAdmissionStore,
      inputApplicationId: input.inputApplicationId,
      ledger: input.ledger,
    })
  }
}

export function reconcileInputApplicationFromHrcLedger(input: {
  inputApplicationStore: Pick<InputApplicationStore, 'getById' | 'update'>
  inputAdmissionStore: InputAdmissionStore
  inputApplicationId: string
  ledger: HrcActiveRunContributionResponse
}): {
  inputApplication: InputApplication
  inputAdmission?: InputAdmissionRecord | undefined
} {
  const current = input.inputApplicationStore.getById(input.inputApplicationId)
  if (current === undefined) {
    throw new Error(`input application not found: ${input.inputApplicationId}`)
  }

  const ledgerStatus = input.ledger.status as string
  if (ledgerStatus === 'accepted' || ledgerStatus === 'duplicate') {
    const inputApplication = input.inputApplicationStore.update(input.inputApplicationId, {
      status: 'accepted',
      ...(input.ledger.runId !== undefined ? { hrcRunId: input.ledger.runId } : {}),
      ...(input.ledger.hostSessionId !== undefined
        ? { hostSessionId: input.ledger.hostSessionId }
        : {}),
      ...(input.ledger.generation !== undefined ? { generation: input.ledger.generation } : {}),
      ...(input.ledger.runtimeId !== undefined ? { runtimeId: input.ledger.runtimeId } : {}),
    })
    return {
      inputApplication,
      inputAdmission: reconcileAdmissionForApplication({
        inputAdmissionStore: input.inputAdmissionStore,
        inputApplication,
        admissionKind: 'accepted_in_flight',
        admissionStatus: 'accepted',
        applicationStatus: 'accepted',
      }),
    }
  }

  if (ledgerStatus === 'rejected' || ledgerStatus === 'failed') {
    const inputApplication = input.inputApplicationStore.update(input.inputApplicationId, {
      status: 'failed',
      ...(input.ledger.errorCode !== undefined ? { lastErrorCode: input.ledger.errorCode } : {}),
      ...(input.ledger.errorMessage !== undefined
        ? { lastErrorMessage: input.ledger.errorMessage }
        : {}),
    })
    return {
      inputApplication,
      inputAdmission: reconcileAdmissionForApplication({
        inputAdmissionStore: input.inputAdmissionStore,
        inputApplication,
        admissionKind: 'rejected',
        admissionStatus: 'rejected',
        applicationStatus: 'failed',
        ...(input.ledger.errorCode !== undefined ? { errorCode: input.ledger.errorCode } : {}),
        ...(input.ledger.errorMessage !== undefined
          ? { errorMessage: input.ledger.errorMessage }
          : {}),
      }),
    }
  }

  const inputApplication = input.inputApplicationStore.update(input.inputApplicationId, {
    status: 'pending',
    ...(input.ledger.runId !== undefined ? { hrcRunId: input.ledger.runId } : {}),
    ...(input.ledger.hostSessionId !== undefined
      ? { hostSessionId: input.ledger.hostSessionId }
      : {}),
    ...(input.ledger.generation !== undefined ? { generation: input.ledger.generation } : {}),
    ...(input.ledger.runtimeId !== undefined ? { runtimeId: input.ledger.runtimeId } : {}),
  })
  return {
    inputApplication,
    inputAdmission: reconcileAdmissionForApplication({
      inputAdmissionStore: input.inputAdmissionStore,
      inputApplication,
      admissionKind: 'admission_pending',
      admissionStatus: 'pending',
      applicationStatus: 'pending',
    }),
  }
}

function reconcileAdmissionForApplication(input: {
  inputAdmissionStore: InputAdmissionStore
  inputApplication: InputApplication
  admissionKind: InputAdmissionRecord['admissionKind']
  admissionStatus: string
  applicationStatus: InputApplicationStatus
  errorCode?: string | undefined
  errorMessage?: string | undefined
}): InputAdmissionRecord | undefined {
  const admission = input.inputAdmissionStore.getByInputAttemptId(
    input.inputApplication.inputAttemptId
  )
  if (admission === undefined) {
    return undefined
  }

  const currentState = {
    ...(admission.currentState ?? {}),
    applicationStatus: input.applicationStatus,
    inputApplicationId: input.inputApplication.inputApplicationId,
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
  }

  return input.inputAdmissionStore.update(admission.inputAttemptId, {
    admissionKind:
      admission.admissionKind === 'admission_pending'
        ? input.admissionKind
        : admission.admissionKind,
    currentState,
    status: input.admissionStatus,
    inputApplicationId: input.inputApplication.inputApplicationId,
  })
}
