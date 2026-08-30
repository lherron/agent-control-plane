import type { RepoContext } from './shared.js'
import { shortId } from './shared.js'

const MIN_SIGNED_64 = -(1n << 63n)
const MAX_SIGNED_64 = (1n << 63n) - 1n

/**
 * T-07728 source-frontier contract. v1 rows carried admitted-atom positions in
 * place of reverse frontiers and are retired by migration rather than read.
 */
export const MOBILE_TIMELINE_PROJECTION_CONTRACT_VERSION = 2

export type MobileTimelineProjectionIdentity = {
  sessionRef: string
  hostSessionId: string
  generation: number
}

export type MobileTimelinePrefixState = 'unknown' | 'complete'

export type MobileTimelineAtomInput = {
  atomId: string
  logicalFrameId: string
  operation: 'append' | 'replace'
  sourceKind: 'hrc' | 'wrkq'
  sourceSeq: number
  sourceTs: string
  payload: Readonly<Record<string, unknown>>
  prefixState: MobileTimelinePrefixState
}

export type MobileTimelineAtomRecord = MobileTimelineAtomInput & {
  projectionEpoch: string
  timelineOrdinal: string
}

export type MobileTimelineProjectionRecord = MobileTimelineProjectionIdentity & {
  projectionEpoch: string
  contractVersion: number
  hrcLedgerIncarnationId: string
  wrkqLedgerIncarnationId: string
  /** Exclusive reverse scan frontier: the next older read is `< hrcBeforeSeq`. */
  hrcBeforeSeq: number
  hrcNewestSeq: number
  /** Exclusive reverse scan frontier: the next older read is `< messageBeforeSeq`. */
  messageBeforeSeq: number
  messageNewestSeq: number
  hrcExhaustedBefore: boolean
  wrkqExhaustedBefore: boolean
  /** Immutable epoch coordinate origin; exists whether or not any atom does. */
  originTimelineOrdinal: string
  minTimelineOrdinal: string | null
  maxTimelineOrdinal: string | null
  active: boolean
  resetReason?: string | undefined
  createdAt: string
  updatedAt: string
}

export type MobileTimelinePageReceiptKey = {
  projectionEpoch: string
  requestDigest: string
  requestedLimit: number
  responseContractVersion: number
}

export type MobileTimelinePageReceipt = MobileTimelinePageReceiptKey & {
  boundaryTimelineOrdinal: string
  atomIds: string[]
  timelineOrdinals: string[]
  olderCursor: string | null
  hasMoreBefore: boolean
  highWaterHrcSeq: number
  highWaterMessageSeq: number
  resetReason: string | null
  createdAt: string
}

export class MobileTimelineOrdinalExhaustedError extends Error {
  readonly code = 'projection_reset'

  constructor() {
    super('mobile timeline ordinal exhausted the signed 64-bit range')
    this.name = 'MobileTimelineOrdinalExhaustedError'
  }
}

export class MobileTimelineProjectionCorruptError extends Error {
  readonly code = 'projection_reset'

  constructor(message: string) {
    super(message)
    this.name = 'MobileTimelineProjectionCorruptError'
  }
}

type ProjectionRow = {
  projection_epoch: string
  session_ref: string
  host_session_id: string
  generation: number
  contract_version: number
  hrc_ledger_incarnation_id: string
  wrkq_ledger_incarnation_id: string
  hrc_before_seq: number
  hrc_newest_seq: number
  message_before_seq: number
  message_newest_seq: number
  hrc_exhausted_before: number
  wrkq_exhausted_before: number
  origin_timeline_ordinal: string
  min_timeline_ordinal: string | null
  max_timeline_ordinal: string | null
  active: number
  reset_reason: string | null
  created_at: string
  updated_at: string
}

type AtomRow = {
  projection_epoch: string
  atom_id: string
  timeline_ordinal: string
  logical_frame_id: string
  operation: 'append' | 'replace'
  source_kind: 'hrc' | 'wrkq'
  source_seq: number
  source_ts: string
  payload_json: string
  prefix_state: MobileTimelinePrefixState
}

type ReceiptRow = {
  projection_epoch: string
  request_digest: string
  requested_limit: number
  response_contract_version: number
  boundary_timeline_ordinal: string
  atom_ids_json: string
  timeline_ordinals_json: string
  older_cursor: string | null
  has_more_before: number
  high_water_hrc_seq: number
  high_water_message_seq: number
  reset_reason: string | null
  created_at: string
}

const PROJECTION_COLUMNS = `*, CAST(origin_timeline_ordinal AS TEXT) AS origin_timeline_ordinal,
                              CAST(min_timeline_ordinal AS TEXT) AS min_timeline_ordinal,
                              CAST(max_timeline_ordinal AS TEXT) AS max_timeline_ordinal`

const ATOM_COLUMNS = `projection_epoch, atom_id, CAST(timeline_ordinal AS TEXT) AS timeline_ordinal,
                      logical_frame_id, operation, source_kind, source_seq, source_ts,
                      payload_json, prefix_state`

function ordinal(value: string): bigint {
  if (!/^-?(0|[1-9]\d*)$/.test(value)) {
    throw new MobileTimelineProjectionCorruptError(`invalid timeline ordinal: ${value}`)
  }
  const parsed = BigInt(value)
  if (parsed < MIN_SIGNED_64 || parsed > MAX_SIGNED_64) {
    throw new MobileTimelineOrdinalExhaustedError()
  }
  return parsed
}

function checkedAdd(value: bigint, delta: bigint): bigint {
  const next = value + delta
  if (next < MIN_SIGNED_64 || next > MAX_SIGNED_64) {
    throw new MobileTimelineOrdinalExhaustedError()
  }
  return next
}

function projectionFromRow(row: ProjectionRow): MobileTimelineProjectionRecord {
  return {
    projectionEpoch: row.projection_epoch,
    sessionRef: row.session_ref,
    hostSessionId: row.host_session_id,
    generation: row.generation,
    contractVersion: row.contract_version,
    hrcLedgerIncarnationId: row.hrc_ledger_incarnation_id,
    wrkqLedgerIncarnationId: row.wrkq_ledger_incarnation_id,
    hrcBeforeSeq: row.hrc_before_seq,
    hrcNewestSeq: row.hrc_newest_seq,
    messageBeforeSeq: row.message_before_seq,
    messageNewestSeq: row.message_newest_seq,
    hrcExhaustedBefore: row.hrc_exhausted_before === 1,
    wrkqExhaustedBefore: row.wrkq_exhausted_before === 1,
    originTimelineOrdinal: row.origin_timeline_ordinal,
    minTimelineOrdinal: row.min_timeline_ordinal,
    maxTimelineOrdinal: row.max_timeline_ordinal,
    active: row.active === 1,
    ...(row.reset_reason !== null ? { resetReason: row.reset_reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function atomFromRow(row: AtomRow): MobileTimelineAtomRecord {
  const payload = JSON.parse(row.payload_json) as unknown
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new MobileTimelineProjectionCorruptError(`atom ${row.atom_id} payload is not an object`)
  }
  return {
    projectionEpoch: row.projection_epoch,
    atomId: row.atom_id,
    timelineOrdinal: row.timeline_ordinal,
    logicalFrameId: row.logical_frame_id,
    operation: row.operation,
    sourceKind: row.source_kind,
    sourceSeq: row.source_seq,
    sourceTs: row.source_ts,
    payload: payload as Readonly<Record<string, unknown>>,
    prefixState: row.prefix_state,
  }
}

function stringList(value: string, label: string): string[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new MobileTimelineProjectionCorruptError(`page receipt ${label} is not a string list`)
  }
  return parsed as string[]
}

function receiptFromRow(row: ReceiptRow): MobileTimelinePageReceipt {
  return {
    projectionEpoch: row.projection_epoch,
    requestDigest: row.request_digest,
    requestedLimit: row.requested_limit,
    responseContractVersion: row.response_contract_version,
    boundaryTimelineOrdinal: row.boundary_timeline_ordinal,
    atomIds: stringList(row.atom_ids_json, 'atom ids'),
    timelineOrdinals: stringList(row.timeline_ordinals_json, 'timeline ordinals'),
    olderCursor: row.older_cursor,
    hasMoreBefore: row.has_more_before === 1,
    highWaterHrcSeq: row.high_water_hrc_seq,
    highWaterMessageSeq: row.high_water_message_seq,
    resetReason: row.reset_reason,
    createdAt: row.created_at,
  }
}

export class MobileTimelineProjectionRepo {
  constructor(private readonly context: RepoContext) {}

  getActive(
    identity: MobileTimelineProjectionIdentity
  ): MobileTimelineProjectionRecord | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT ${PROJECTION_COLUMNS}
           FROM mobile_timeline_projection_epochs
          WHERE session_ref = ? AND host_session_id = ? AND generation = ? AND active = 1`
      )
      .get(identity.sessionRef, identity.hostSessionId, identity.generation) as
      | ProjectionRow
      | undefined
    if (row === undefined) return undefined
    const projection = projectionFromRow(row)
    this.assertContiguousOrdinals(projection)
    return projection
  }

  getEpoch(projectionEpoch: string): MobileTimelineProjectionRecord | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT ${PROJECTION_COLUMNS}
           FROM mobile_timeline_projection_epochs WHERE projection_epoch = ?`
      )
      .get(projectionEpoch) as ProjectionRow | undefined
    if (row === undefined) return undefined
    const projection = projectionFromRow(row)
    this.assertContiguousOrdinals(projection)
    return projection
  }

  replaceEpoch(input: {
    identity: MobileTimelineProjectionIdentity
    hrcLedgerIncarnationId: string
    wrkqLedgerIncarnationId: string
    hrcBeforeSeq: number
    hrcNewestSeq: number
    messageBeforeSeq: number
    messageNewestSeq: number
    hrcExhaustedBefore: boolean
    wrkqExhaustedBefore: boolean
    resetReason?: string | undefined
    originTimelineOrdinal?: string | undefined
    atoms: MobileTimelineAtomInput[]
  }): { projection: MobileTimelineProjectionRecord; atoms: MobileTimelineAtomRecord[] } {
    return this.context.sqlite.transaction(() => {
      const origin = ordinal(input.originTimelineOrdinal ?? '0')
      const end =
        input.atoms.length === 0 ? undefined : checkedAdd(origin, BigInt(input.atoms.length - 1))
      const now = new Date().toISOString()
      const epoch = shortId('tlp_')
      this.context.sqlite
        .prepare(
          `UPDATE mobile_timeline_projection_epochs SET active = 0, updated_at = ?
            WHERE session_ref = ? AND host_session_id = ? AND generation = ? AND active = 1`
        )
        .run(
          now,
          input.identity.sessionRef,
          input.identity.hostSessionId,
          input.identity.generation
        )
      // Page receipts retire with their epoch: a retired epoch can never be the
      // active epoch a cursor fences against, so its receipts are unreachable.
      this.context.sqlite
        .prepare(
          `DELETE FROM mobile_timeline_page_receipts
            WHERE projection_epoch IN (
              SELECT projection_epoch FROM mobile_timeline_projection_epochs
               WHERE session_ref = ? AND host_session_id = ? AND generation = ? AND active = 0
            )`
        )
        .run(input.identity.sessionRef, input.identity.hostSessionId, input.identity.generation)
      this.context.sqlite
        .prepare(
          `INSERT INTO mobile_timeline_projection_epochs (
             projection_epoch, session_ref, host_session_id, generation, contract_version,
             hrc_ledger_incarnation_id, wrkq_ledger_incarnation_id,
             hrc_before_seq, hrc_newest_seq, message_before_seq, message_newest_seq,
             hrc_exhausted_before, wrkq_exhausted_before,
             origin_timeline_ordinal, min_timeline_ordinal, max_timeline_ordinal,
             active, reset_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          epoch,
          input.identity.sessionRef,
          input.identity.hostSessionId,
          input.identity.generation,
          MOBILE_TIMELINE_PROJECTION_CONTRACT_VERSION,
          input.hrcLedgerIncarnationId,
          input.wrkqLedgerIncarnationId,
          input.hrcBeforeSeq,
          input.hrcNewestSeq,
          input.messageBeforeSeq,
          input.messageNewestSeq,
          input.hrcExhaustedBefore ? 1 : 0,
          input.wrkqExhaustedBefore ? 1 : 0,
          origin,
          end === undefined ? null : origin,
          end ?? null,
          input.resetReason ?? null,
          now,
          now
        )
      input.atoms.forEach((item, index) =>
        this.insertAtom(epoch, checkedAdd(origin, BigInt(index)), item)
      )
      return {
        projection: this.requireEpoch(epoch),
        atoms: this.listNewest(epoch, input.atoms.length),
      }
    })()
  }

  appendAtoms(input: {
    projectionEpoch: string
    atoms: MobileTimelineAtomInput[]
    hrcNewestSeq: number
    messageNewestSeq: number
  }): { projection: MobileTimelineProjectionRecord; inserted: MobileTimelineAtomRecord[] } {
    return this.context.sqlite.transaction(() => {
      const projection = this.requireActiveEpoch(input.projectionEpoch)
      const fresh = this.freshAtoms(input.projectionEpoch, input.atoms)
      const start =
        projection.maxTimelineOrdinal === null
          ? ordinal(projection.originTimelineOrdinal)
          : checkedAdd(ordinal(projection.maxTimelineOrdinal), 1n)
      fresh.forEach((item, index) =>
        this.insertAtom(input.projectionEpoch, checkedAdd(start, BigInt(index)), item)
      )
      const max =
        fresh.length === 0
          ? projection.maxTimelineOrdinal
          : checkedAdd(start, BigInt(fresh.length - 1)).toString()
      const min = projection.minTimelineOrdinal ?? (fresh.length === 0 ? null : start.toString())
      this.updateBounds(input.projectionEpoch, {
        min,
        max,
        hrcNewestSeq: input.hrcNewestSeq,
        messageNewestSeq: input.messageNewestSeq,
      })
      return {
        projection: this.requireEpoch(input.projectionEpoch),
        inserted: this.atomsByIds(
          input.projectionEpoch,
          fresh.map((item) => item.atomId)
        ),
      }
    })()
  }

  /**
   * Commits one bounded older scan. Frontiers advance even when the scan
   * projected no atom, so a batch of non-projecting raw rows still makes
   * durable reverse progress.
   */
  prependAtoms(input: {
    projectionEpoch: string
    atoms: MobileTimelineAtomInput[]
    hrcBeforeSeq: number
    messageBeforeSeq: number
    hrcExhaustedBefore: boolean
    wrkqExhaustedBefore: boolean
  }): { projection: MobileTimelineProjectionRecord; inserted: MobileTimelineAtomRecord[] } {
    return this.context.sqlite.transaction(() => {
      const projection = this.requireActiveEpoch(input.projectionEpoch)
      const fresh = this.freshAtoms(input.projectionEpoch, input.atoms)
      const end = checkedAdd(
        ordinal(projection.minTimelineOrdinal ?? projection.originTimelineOrdinal),
        -1n
      )
      const start = fresh.length === 0 ? end : checkedAdd(end, -BigInt(fresh.length - 1))
      fresh.forEach((item, index) =>
        this.insertAtom(input.projectionEpoch, checkedAdd(start, BigInt(index)), item)
      )
      const min = fresh.length === 0 ? projection.minTimelineOrdinal : start.toString()
      const max = projection.maxTimelineOrdinal ?? (fresh.length === 0 ? null : end.toString())
      this.context.sqlite
        .prepare(
          `UPDATE mobile_timeline_projection_epochs
              SET hrc_before_seq = ?, message_before_seq = ?,
                  hrc_exhausted_before = ?, wrkq_exhausted_before = ?,
                  min_timeline_ordinal = ?, max_timeline_ordinal = ?, updated_at = ?
            WHERE projection_epoch = ? AND active = 1`
        )
        .run(
          input.hrcBeforeSeq,
          input.messageBeforeSeq,
          input.hrcExhaustedBefore ? 1 : 0,
          input.wrkqExhaustedBefore ? 1 : 0,
          min === null ? null : BigInt(min),
          max === null ? null : BigInt(max),
          new Date().toISOString(),
          input.projectionEpoch
        )
      return {
        projection: this.requireEpoch(input.projectionEpoch),
        inserted: this.atomsByIds(
          input.projectionEpoch,
          fresh.map((item) => item.atomId)
        ),
      }
    })()
  }

  listNewest(projectionEpoch: string, limit: number): MobileTimelineAtomRecord[] {
    if (limit <= 0) return []
    const rows = this.context.sqlite
      .prepare(
        `SELECT * FROM (
           SELECT ${ATOM_COLUMNS}
             FROM mobile_timeline_atoms
            WHERE projection_epoch = ?
            ORDER BY mobile_timeline_atoms.timeline_ordinal DESC LIMIT ?
         ) ORDER BY CAST(timeline_ordinal AS INTEGER) ASC`
      )
      .all(projectionEpoch, limit) as AtomRow[]
    return rows.map(atomFromRow)
  }

  listBefore(
    projectionEpoch: string,
    beforeOrdinal: string,
    limit: number
  ): MobileTimelineAtomRecord[] {
    if (limit <= 0) return []
    const before = ordinal(beforeOrdinal)
    const rows = this.context.sqlite
      .prepare(
        `SELECT * FROM (
           SELECT ${ATOM_COLUMNS}
             FROM mobile_timeline_atoms
            WHERE projection_epoch = ? AND timeline_ordinal < ?
            ORDER BY mobile_timeline_atoms.timeline_ordinal DESC LIMIT ?
         ) ORDER BY CAST(timeline_ordinal AS INTEGER) ASC`
      )
      .all(projectionEpoch, before, limit) as AtomRow[]
    return rows.map(atomFromRow)
  }

  /** Replays a committed atom list in the exact order a page receipt recorded. */
  listByAtomIds(projectionEpoch: string, atomIds: string[]): MobileTimelineAtomRecord[] {
    if (atomIds.length === 0) return []
    const byId = new Map(
      this.atomsByIds(projectionEpoch, atomIds).map((item) => [item.atomId, item])
    )
    return atomIds.map((atomId) => {
      const record = byId.get(atomId)
      if (record === undefined) {
        throw new MobileTimelineProjectionCorruptError(
          `page receipt references missing atom ${atomId} in epoch ${projectionEpoch}`
        )
      }
      return record
    })
  }

  hasOrdinal(projectionEpoch: string, timelineOrdinal: string): boolean {
    const value = ordinal(timelineOrdinal)
    const row = this.context.sqlite
      .prepare(
        `SELECT 1 AS present FROM mobile_timeline_atoms
          WHERE projection_epoch = ? AND timeline_ordinal = ? LIMIT 1`
      )
      .get(projectionEpoch, value) as { present: number } | undefined
    return row?.present === 1
  }

  getPageReceipt(key: MobileTimelinePageReceiptKey): MobileTimelinePageReceipt | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT *, CAST(boundary_timeline_ordinal AS TEXT) AS boundary_timeline_ordinal
           FROM mobile_timeline_page_receipts
          WHERE projection_epoch = ? AND request_digest = ?
            AND requested_limit = ? AND response_contract_version = ?`
      )
      .get(
        key.projectionEpoch,
        key.requestDigest,
        key.requestedLimit,
        key.responseContractVersion
      ) as ReceiptRow | undefined
    return row === undefined ? undefined : receiptFromRow(row)
  }

  /**
   * Persists a page receipt before the response is returned. The first writer
   * for a request identity wins; a concurrent duplicate reads back the stored
   * receipt instead of overwriting it.
   */
  putPageReceipt(input: Omit<MobileTimelinePageReceipt, 'createdAt'>): MobileTimelinePageReceipt {
    return this.context.sqlite.transaction(() => {
      this.requireActiveEpoch(input.projectionEpoch)
      if (input.atomIds.length > input.requestedLimit) {
        throw new MobileTimelineProjectionCorruptError(
          `page receipt records ${input.atomIds.length} atoms above its ${input.requestedLimit} limit`
        )
      }
      if (input.atomIds.length !== input.timelineOrdinals.length) {
        throw new MobileTimelineProjectionCorruptError(
          'page receipt atom ids and timeline ordinals disagree in length'
        )
      }
      this.context.sqlite
        .prepare(
          `INSERT INTO mobile_timeline_page_receipts (
             projection_epoch, request_digest, requested_limit, response_contract_version,
             boundary_timeline_ordinal, atom_ids_json, timeline_ordinals_json,
             older_cursor, has_more_before, high_water_hrc_seq, high_water_message_seq,
             reset_reason, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (projection_epoch, request_digest, requested_limit, response_contract_version)
           DO NOTHING`
        )
        .run(
          input.projectionEpoch,
          input.requestDigest,
          input.requestedLimit,
          input.responseContractVersion,
          ordinal(input.boundaryTimelineOrdinal),
          JSON.stringify(input.atomIds),
          JSON.stringify(input.timelineOrdinals),
          input.olderCursor,
          input.hasMoreBefore ? 1 : 0,
          input.highWaterHrcSeq,
          input.highWaterMessageSeq,
          input.resetReason,
          new Date().toISOString()
        )
      const stored = this.getPageReceipt(input)
      if (stored === undefined) {
        throw new MobileTimelineProjectionCorruptError('page receipt did not persist')
      }
      return stored
    })()
  }

  private assertContiguousOrdinals(projection: MobileTimelineProjectionRecord): void {
    const row = this.context.sqlite
      .prepare(
        `SELECT COUNT(*) AS atom_count,
                CAST(MIN(timeline_ordinal) AS TEXT) AS min_ordinal,
                CAST(MAX(timeline_ordinal) AS TEXT) AS max_ordinal
           FROM mobile_timeline_atoms WHERE projection_epoch = ?`
      )
      .get(projection.projectionEpoch) as {
      atom_count: number
      min_ordinal: string | null
      max_ordinal: string | null
    }
    if (row.atom_count === 0) {
      if (projection.minTimelineOrdinal === null && projection.maxTimelineOrdinal === null) return
      throw new MobileTimelineProjectionCorruptError(
        `projection ${projection.projectionEpoch} has bounds without atoms`
      )
    }
    if (
      row.min_ordinal === null ||
      row.max_ordinal === null ||
      row.min_ordinal !== projection.minTimelineOrdinal ||
      row.max_ordinal !== projection.maxTimelineOrdinal ||
      BigInt(row.atom_count) !== ordinal(row.max_ordinal) - ordinal(row.min_ordinal) + 1n
    ) {
      throw new MobileTimelineProjectionCorruptError(
        `projection ${projection.projectionEpoch} has a non-contiguous atom ordinal range`
      )
    }
  }

  private requireEpoch(epoch: string): MobileTimelineProjectionRecord {
    const projection = this.getEpoch(epoch)
    if (projection === undefined) {
      throw new MobileTimelineProjectionCorruptError(`unknown projection epoch: ${epoch}`)
    }
    return projection
  }

  private requireActiveEpoch(epoch: string): MobileTimelineProjectionRecord {
    const projection = this.requireEpoch(epoch)
    if (!projection.active) {
      throw new MobileTimelineProjectionCorruptError(`retired projection epoch: ${epoch}`)
    }
    return projection
  }

  private freshAtoms(epoch: string, atoms: MobileTimelineAtomInput[]): MobileTimelineAtomInput[] {
    const seen = new Set<string>()
    return atoms.filter((item) => {
      if (seen.has(item.atomId)) return false
      seen.add(item.atomId)
      const row = this.context.sqlite
        .prepare(
          `SELECT logical_frame_id, operation, source_kind, source_seq, source_ts,
                  payload_json, prefix_state
             FROM mobile_timeline_atoms WHERE projection_epoch = ? AND atom_id = ?`
        )
        .get(epoch, item.atomId) as
        | {
            logical_frame_id: string
            operation: string
            source_kind: string
            source_seq: number
            source_ts: string
            payload_json: string
            prefix_state: string
          }
        | undefined
      if (row === undefined) return true
      const same =
        row.logical_frame_id === item.logicalFrameId &&
        row.operation === item.operation &&
        row.source_kind === item.sourceKind &&
        row.source_seq === item.sourceSeq &&
        row.source_ts === item.sourceTs &&
        row.payload_json === JSON.stringify(item.payload) &&
        row.prefix_state === item.prefixState
      if (!same) {
        throw new MobileTimelineProjectionCorruptError(
          `source identity ${item.atomId} changed immutable projected content`
        )
      }
      return false
    })
  }

  private insertAtom(epoch: string, value: bigint, atom: MobileTimelineAtomInput): void {
    this.context.sqlite
      .prepare(
        `INSERT INTO mobile_timeline_atoms (
           projection_epoch, atom_id, timeline_ordinal, logical_frame_id, operation,
           source_kind, source_seq, source_ts, payload_json, prefix_state
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        epoch,
        atom.atomId,
        value,
        atom.logicalFrameId,
        atom.operation,
        atom.sourceKind,
        atom.sourceSeq,
        atom.sourceTs,
        JSON.stringify(atom.payload),
        atom.prefixState
      )
  }

  private updateBounds(
    epoch: string,
    input: {
      min: string | null
      max: string | null
      hrcNewestSeq: number
      messageNewestSeq: number
    }
  ): void {
    this.context.sqlite
      .prepare(
        `UPDATE mobile_timeline_projection_epochs
            SET hrc_newest_seq = ?, message_newest_seq = ?,
                min_timeline_ordinal = ?, max_timeline_ordinal = ?, updated_at = ?
          WHERE projection_epoch = ? AND active = 1`
      )
      .run(
        input.hrcNewestSeq,
        input.messageNewestSeq,
        input.min === null ? null : BigInt(input.min),
        input.max === null ? null : BigInt(input.max),
        new Date().toISOString(),
        epoch
      )
  }

  private atomsByIds(epoch: string, ids: string[]): MobileTimelineAtomRecord[] {
    if (ids.length === 0) return []
    const wanted = new Set(ids)
    return this.context.sqlite
      .prepare(
        `SELECT ${ATOM_COLUMNS}
           FROM mobile_timeline_atoms
          WHERE projection_epoch = ?
          ORDER BY mobile_timeline_atoms.timeline_ordinal ASC`
      )
      .all(epoch)
      .map((row) => atomFromRow(row as AtomRow))
      .filter((item) => wanted.has(item.atomId))
  }
}
