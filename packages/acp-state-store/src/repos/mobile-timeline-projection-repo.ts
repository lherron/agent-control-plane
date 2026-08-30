import type { RepoContext } from './shared.js'
import { shortId } from './shared.js'

const MIN_SIGNED_64 = -(1n << 63n)
const MAX_SIGNED_64 = (1n << 63n) - 1n

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
  hrcLedgerIncarnationId: string
  wrkqLedgerIncarnationId: string
  hrcOldestSeq: number
  hrcNewestSeq: number
  messageOldestSeq: number
  messageNewestSeq: number
  hrcExhaustedBefore: boolean
  wrkqExhaustedBefore: boolean
  minTimelineOrdinal: string | null
  maxTimelineOrdinal: string | null
  active: boolean
  resetReason?: string | undefined
  createdAt: string
  updatedAt: string
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
  hrc_ledger_incarnation_id: string
  wrkq_ledger_incarnation_id: string
  hrc_oldest_seq: number
  hrc_newest_seq: number
  message_oldest_seq: number
  message_newest_seq: number
  hrc_exhausted_before: number
  wrkq_exhausted_before: number
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
    hrcLedgerIncarnationId: row.hrc_ledger_incarnation_id,
    wrkqLedgerIncarnationId: row.wrkq_ledger_incarnation_id,
    hrcOldestSeq: row.hrc_oldest_seq,
    hrcNewestSeq: row.hrc_newest_seq,
    messageOldestSeq: row.message_oldest_seq,
    messageNewestSeq: row.message_newest_seq,
    hrcExhaustedBefore: row.hrc_exhausted_before === 1,
    wrkqExhaustedBefore: row.wrkq_exhausted_before === 1,
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

export class MobileTimelineProjectionRepo {
  constructor(private readonly context: RepoContext) {}

  getActive(
    identity: MobileTimelineProjectionIdentity
  ): MobileTimelineProjectionRecord | undefined {
    const row = this.context.sqlite
      .prepare(
        `SELECT *, CAST(min_timeline_ordinal AS TEXT) AS min_timeline_ordinal,
                   CAST(max_timeline_ordinal AS TEXT) AS max_timeline_ordinal
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
        `SELECT *, CAST(min_timeline_ordinal AS TEXT) AS min_timeline_ordinal,
                   CAST(max_timeline_ordinal AS TEXT) AS max_timeline_ordinal
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
    hrcOldestSeq: number
    hrcNewestSeq: number
    messageOldestSeq: number
    messageNewestSeq: number
    hrcExhaustedBefore: boolean
    wrkqExhaustedBefore: boolean
    resetReason?: string | undefined
    initialOrdinal?: string | undefined
    atoms: MobileTimelineAtomInput[]
  }): { projection: MobileTimelineProjectionRecord; atoms: MobileTimelineAtomRecord[] } {
    return this.context.sqlite.transaction(() => {
      const start = ordinal(input.initialOrdinal ?? '0')
      const end =
        input.atoms.length === 0 ? undefined : checkedAdd(start, BigInt(input.atoms.length - 1))
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
      this.context.sqlite
        .prepare(
          `INSERT INTO mobile_timeline_projection_epochs (
             projection_epoch, session_ref, host_session_id, generation,
             hrc_ledger_incarnation_id, wrkq_ledger_incarnation_id,
             hrc_oldest_seq, hrc_newest_seq, message_oldest_seq, message_newest_seq,
             hrc_exhausted_before, wrkq_exhausted_before,
             min_timeline_ordinal, max_timeline_ordinal, active, reset_reason,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        )
        .run(
          epoch,
          input.identity.sessionRef,
          input.identity.hostSessionId,
          input.identity.generation,
          input.hrcLedgerIncarnationId,
          input.wrkqLedgerIncarnationId,
          input.hrcOldestSeq,
          input.hrcNewestSeq,
          input.messageOldestSeq,
          input.messageNewestSeq,
          input.hrcExhaustedBefore ? 1 : 0,
          input.wrkqExhaustedBefore ? 1 : 0,
          end === undefined ? null : start,
          end ?? null,
          input.resetReason ?? null,
          now,
          now
        )
      input.atoms.forEach((item, index) =>
        this.insertAtom(epoch, checkedAdd(start, BigInt(index)), item)
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
          ? 0n
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

  prependAtoms(input: {
    projectionEpoch: string
    atoms: MobileTimelineAtomInput[]
    hrcOldestSeq: number
    messageOldestSeq: number
    hrcExhaustedBefore: boolean
    wrkqExhaustedBefore: boolean
  }): { projection: MobileTimelineProjectionRecord; inserted: MobileTimelineAtomRecord[] } {
    return this.context.sqlite.transaction(() => {
      const projection = this.requireActiveEpoch(input.projectionEpoch)
      const fresh = this.freshAtoms(input.projectionEpoch, input.atoms)
      const end =
        projection.minTimelineOrdinal === null
          ? -1n
          : checkedAdd(ordinal(projection.minTimelineOrdinal), -1n)
      const start = fresh.length === 0 ? end : checkedAdd(end, -BigInt(fresh.length - 1))
      fresh.forEach((item, index) =>
        this.insertAtom(input.projectionEpoch, checkedAdd(start, BigInt(index)), item)
      )
      const min = fresh.length === 0 ? projection.minTimelineOrdinal : start.toString()
      const max = projection.maxTimelineOrdinal ?? (fresh.length === 0 ? null : end.toString())
      this.context.sqlite
        .prepare(
          `UPDATE mobile_timeline_projection_epochs
              SET hrc_oldest_seq = ?, message_oldest_seq = ?,
                  hrc_exhausted_before = ?, wrkq_exhausted_before = ?,
                  min_timeline_ordinal = ?, max_timeline_ordinal = ?, updated_at = ?
            WHERE projection_epoch = ? AND active = 1`
        )
        .run(
          input.hrcOldestSeq,
          input.messageOldestSeq,
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
           SELECT projection_epoch, atom_id, CAST(timeline_ordinal AS TEXT) AS timeline_ordinal,
                  logical_frame_id, operation, source_kind, source_seq, source_ts,
                  payload_json, prefix_state
             FROM mobile_timeline_atoms
            WHERE projection_epoch = ? ORDER BY timeline_ordinal DESC LIMIT ?
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
           SELECT projection_epoch, atom_id, CAST(timeline_ordinal AS TEXT) AS timeline_ordinal,
                  logical_frame_id, operation, source_kind, source_seq, source_ts,
                  payload_json, prefix_state
             FROM mobile_timeline_atoms
            WHERE projection_epoch = ? AND timeline_ordinal < ?
            ORDER BY timeline_ordinal DESC LIMIT ?
         ) ORDER BY CAST(timeline_ordinal AS INTEGER) ASC`
      )
      .all(projectionEpoch, before, limit) as AtomRow[]
    return rows.map(atomFromRow)
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
        `SELECT projection_epoch, atom_id, CAST(timeline_ordinal AS TEXT) AS timeline_ordinal,
                logical_frame_id, operation, source_kind, source_seq, source_ts,
                payload_json, prefix_state
           FROM mobile_timeline_atoms WHERE projection_epoch = ? ORDER BY timeline_ordinal ASC`
      )
      .all(epoch)
      .map((row) => atomFromRow(row as AtomRow))
      .filter((item) => wanted.has(item.atomId))
  }
}
