import { createHash } from 'node:crypto'

import type {
  AcpStateStore,
  WrkfParticipantCapturesRepo,
  WrkfRouteIdempotencyRepo,
} from 'acp-state-store'

import type { CaptureRecord } from './participant-output.js'
import type { EvidenceRecord, ObligationRecord } from './projections.js'

/**
 * Generalized wrkf route idempotency contract (formerly PbcRouteIdempotencyStore).
 * `key` is the opaque, caller-built composite (e.g. `${routeKey}:${idempotencyKey}`);
 * the store treats it as the dedupe unit and detects body-hash conflicts.
 */
export interface WrkfRouteIdempotencyStore {
  check(
    key: string,
    bodyHash: string
  ): Promise<{ state: 'fresh' } | { state: 'replay'; result: unknown } | { state: 'conflict' }>
  persist(key: string, bodyHash: string, result: unknown): Promise<void>
}

/**
 * Generalized wrkf participant-capture contract (formerly PbcCaptureStore).
 * Keyed by captureKey; round-trips the full CaptureRecord for replay idempotency.
 */
export interface WrkfParticipantCaptureStore {
  get(captureKey: string): Promise<CaptureRecord | undefined>
  set(captureKey: string, record: CaptureRecord): Promise<void>
}

/** @deprecated Use WrkfRouteIdempotencyStore. */
export type PbcRouteIdempotencyStore = WrkfRouteIdempotencyStore
/** @deprecated Use WrkfParticipantCaptureStore. */
export type PbcCaptureStore = WrkfParticipantCaptureStore

// ---------------------------------------------------------------------------
// In-memory implementations — retained ONLY for tests / the default fallback
// when no durable state store is wired.
// ---------------------------------------------------------------------------

export class InMemoryWrkfRouteIdempotencyStore implements WrkfRouteIdempotencyStore {
  private readonly records = new Map<string, { bodyHash: string; result: unknown }>()

  async check(
    key: string,
    bodyHash: string
  ): Promise<{ state: 'fresh' } | { state: 'replay'; result: unknown } | { state: 'conflict' }> {
    const record = this.records.get(key)
    if (record === undefined) {
      return { state: 'fresh' }
    }
    if (record.bodyHash !== bodyHash) {
      return { state: 'conflict' }
    }
    return { state: 'replay', result: record.result }
  }

  async persist(key: string, bodyHash: string, result: unknown): Promise<void> {
    this.records.set(key, { bodyHash, result })
  }
}

export class InMemoryWrkfParticipantCaptureStore implements WrkfParticipantCaptureStore {
  private readonly records = new Map<string, CaptureRecord>()

  async get(captureKey: string): Promise<CaptureRecord | undefined> {
    return this.records.get(captureKey)
  }

  async set(captureKey: string, record: CaptureRecord): Promise<void> {
    this.records.set(captureKey, record)
  }
}

/** @deprecated Use InMemoryWrkfRouteIdempotencyStore. */
export const InMemoryPbcIdempotencyStore = InMemoryWrkfRouteIdempotencyStore
/** @deprecated Use InMemoryWrkfParticipantCaptureStore. */
export const InMemoryPbcCaptureStore = InMemoryWrkfParticipantCaptureStore

// ---------------------------------------------------------------------------
// Durable implementations — backed by acp-state-store repos (Phase 4a).
// ---------------------------------------------------------------------------

const DURABLE_KEY_PLACEHOLDER = '-'

/**
 * Maps the opaque idempotency `key` onto the repo's composite primary key.
 * The store treats `key` as the whole dedupe unit, so route/taskId/actorHash
 * are deterministic placeholders and the opaque key carries the identity.
 */
function toRepoKey(key: string): {
  route: string
  taskId: string
  actorHash: string
  idempotencyKey: string
} {
  return {
    route: DURABLE_KEY_PLACEHOLDER,
    taskId: DURABLE_KEY_PLACEHOLDER,
    actorHash: DURABLE_KEY_PLACEHOLDER,
    idempotencyKey: key,
  }
}

export class DurableWrkfRouteIdempotencyStore implements WrkfRouteIdempotencyStore {
  constructor(private readonly repo: WrkfRouteIdempotencyRepo) {}

  async check(
    key: string,
    bodyHash: string
  ): Promise<{ state: 'fresh' } | { state: 'replay'; result: unknown } | { state: 'conflict' }> {
    const record = this.repo.get(toRepoKey(key))
    if (record === undefined || record.status !== 'completed') {
      return { state: 'fresh' }
    }
    if (record.bodyHash !== bodyHash) {
      return { state: 'conflict' }
    }
    return { state: 'replay', result: record.responseJson }
  }

  async persist(key: string, bodyHash: string, result: unknown): Promise<void> {
    const repoKey = toRepoKey(key)
    this.repo.admitOrReplay({ ...repoKey, bodyHash })
    this.repo.recordResponse({ ...repoKey, responseJson: result })
  }
}

function hashCaptureRecord(record: CaptureRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex')
}

/**
 * Durable capture store backed by WrkfParticipantCapturesRepo.
 *
 * The PbcCaptureStore contract is keyed only by captureKey and round-trips the
 * full CaptureRecord (evidence/obligation records, not just ids). The repo's
 * evidence_ids_json / obligation_ids_json TEXT columns are repurposed to carry
 * the full record arrays; task/workflow/run metadata is unknown on this path so
 * deterministic placeholders are used. captureKey remains the dedupe identity.
 */
export class DurableWrkfParticipantCaptureStore implements WrkfParticipantCaptureStore {
  constructor(private readonly repo: WrkfParticipantCapturesRepo) {}

  async get(captureKey: string): Promise<CaptureRecord | undefined> {
    const record = this.repo.get(captureKey)
    if (record === undefined) {
      return undefined
    }
    return {
      status: 'ingested',
      evidenceAdded: record.evidenceIds as unknown as EvidenceRecord[],
      obligationsSatisfied: record.obligationIds as unknown as ObligationRecord[],
    }
  }

  async set(captureKey: string, record: CaptureRecord): Promise<void> {
    this.repo.setOrConflict({
      captureKey,
      taskId: DURABLE_KEY_PLACEHOLDER,
      workflowRef: DURABLE_KEY_PLACEHOLDER,
      wrkfRunId: DURABLE_KEY_PLACEHOLDER,
      bodyHash: hashCaptureRecord(record),
      evidenceIds: record.evidenceAdded as unknown as string[],
      obligationIds: record.obligationsSatisfied as unknown as string[],
    })
  }
}

export function createDurableWrkfStores(stateStore: AcpStateStore): {
  idempotencyStore: WrkfRouteIdempotencyStore
  captureStore: WrkfParticipantCaptureStore
} {
  return {
    idempotencyStore: new DurableWrkfRouteIdempotencyStore(stateStore.wrkfRouteIdempotency),
    captureStore: new DurableWrkfParticipantCaptureStore(stateStore.wrkfParticipantCaptures),
  }
}
