import { createHash } from 'node:crypto'
import type {
  MobileTimelineAtomInput,
  MobileTimelineAtomRecord,
  MobileTimelinePageReceipt,
  MobileTimelineProjectionIdentity,
  MobileTimelineProjectionRecord,
  MobileTimelineProjectionRepo,
} from 'acp-state-store'
import { MobileTimelineProjectionCorruptError } from 'acp-state-store'
import type { HrcLifecycleEvent } from 'hrc-core'
import type { HrcEventTail } from 'hrc-sdk'
import type { CollaborationLedger, CollaborationMessage, CollaborationMessagePage } from 'wrkq-lib'

const DEFAULT_TARGET = 50
const MAX_TARGET = 100
const DEFAULT_MAX_ATOMS = 2_048
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const PRODUCER_PAGE_LIMIT = 500
const CURSOR_VERSION = 2
const CURSOR_TYPE = 'mobile_history'
const MAX_CURSOR_BYTES = 4_096

/**
 * Response-contract version. It is part of page-receipt identity so a receipt
 * minted under one response shape can never satisfy a later one.
 */
export const MOBILE_HISTORY_RESPONSE_CONTRACT_VERSION = 2

export type MobileTimelineProjectorIdentity = MobileTimelineProjectionIdentity & {
  memberRef: string
}

export type MobileTimelineProjectionTemplate = Omit<
  MobileTimelineAtomInput,
  'atomId' | 'sourceKind' | 'sourceSeq' | 'sourceTs'
>

export type MobileTimelinePage = {
  projectionEpoch: string
  atoms: MobileTimelineAtomRecord[]
  olderCursor: string | null
  hasMoreBefore: boolean
  highWater: { hrcSeq: number; messageSeq: number }
  resetReason?: string | undefined
}

export class MobileTimelineMalformedCursorError extends Error {
  readonly code = 'malformed_request'
  readonly status = 400
}

export class MobileTimelineCursorInvalidError extends Error {
  readonly code = 'cursor_invalid'
  readonly status = 409
}

export class MobileTimelineItemOversizeError extends Error {
  readonly code = 'timeline_item_oversize'
  readonly status = 422
}

/**
 * A captured producer head at the top of the representable range leaves no
 * exclusive `head + 1` frontier to mint. Failing here keeps the alternative —
 * wrapping or silently skipping the head — off the table.
 */
export class MobileTimelineSourcePositionExhaustedError extends Error {
  readonly code = 'projection_reset'
  readonly status = 409
}

type CursorPayload = {
  v: 2
  type: 'mobile_history'
  sessionRef: string
  hostSessionId: string
  generation: number
  hrcLedgerIncarnationId: string
  wrkqLedgerIncarnationId: string
  projectionEpoch: string
  originTimelineOrdinal: string
  beforeTimelineOrdinal: string
  beforeHrcSeq: number
  beforeMessageSeq: number
}

type ProjectorOptions = {
  target: number
  maxAtoms: number
  maxBytes: number
}

type ProjectorDeps = {
  store: MobileTimelineProjectionRepo
  hrcClient: {
    tailEvents(
      options: Parameters<import('hrc-sdk').HrcClient['tailEvents']>[0]
    ): Promise<HrcEventTail>
  }
  collaborationLedger: Pick<CollaborationLedger, 'pageMessagesByMember'>
  projectHrc(
    event: HrcLifecycleEvent,
    matchedCollaboration?: CollaborationMessage | undefined
  ): MobileTimelineProjectionTemplate | undefined
  projectCollaboration(message: CollaborationMessage): MobileTimelineProjectionTemplate | undefined
  collaborationMatchesHrc?:
    | ((event: HrcLifecycleEvent, message: CollaborationMessage) => boolean)
    | undefined
}

type ClosedSources = {
  hrc: HrcLifecycleEvent[]
  wrkq: CollaborationMessage[]
  hrcIncarnation: string
  wrkqIncarnation: string
  hrcHead: number
  wrkqHead: number
  hrcHasMoreBefore: boolean
  wrkqHasMoreBefore: boolean
}

/**
 * One raw source row in cross-producer merge order, carrying the atom it
 * projects to when it projects to one. Selection walks raw rows rather than
 * atoms so reverse frontiers can advance past rows that project away,
 * deduplicate, or are intentionally suppressed.
 */
type MergedRow = {
  source: 'hrc' | 'wrkq'
  seq: number
  rawBytes: number
  atom: MobileTimelineAtomInput | undefined
}

type ScanBudget = { records: number; bytes: number }

type Selection = {
  atoms: MobileTimelineAtomInput[]
  hrcConsumed: number
  wrkqConsumed: number
  hrcLowestConsumedSeq: number | undefined
  wrkqLowestConsumedSeq: number | undefined
  ceilingReached: boolean
}

function options(input: Partial<ProjectorOptions> = {}): ProjectorOptions {
  const target = input.target ?? DEFAULT_TARGET
  const maxAtoms = input.maxAtoms ?? DEFAULT_MAX_ATOMS
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  if (!Number.isSafeInteger(target) || target < 1 || target > MAX_TARGET) {
    throw new RangeError(`timeline target must be an integer from 1 through ${MAX_TARGET}`)
  }
  if (!Number.isSafeInteger(maxAtoms) || maxAtoms < 1 || maxAtoms > DEFAULT_MAX_ATOMS) {
    throw new RangeError(`timeline atom ceiling must be from 1 through ${DEFAULT_MAX_ATOMS}`)
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new RangeError(`timeline byte ceiling must be from 1 through ${DEFAULT_MAX_BYTES}`)
  }
  return { target, maxAtoms, maxBytes }
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function compareClosedInputs(
  lhs: { source: 'hrc' | 'wrkq'; seq: number; ts: string },
  rhs: { source: 'hrc' | 'wrkq'; seq: number; ts: string }
): number {
  const time = lhs.ts.localeCompare(rhs.ts)
  if (time !== 0) return time
  const rank = (lhs.source === 'hrc' ? 0 : 1) - (rhs.source === 'hrc' ? 0 : 1)
  return rank !== 0 ? rank : lhs.seq - rhs.seq
}

function stableClosedMerge(
  hrc: HrcLifecycleEvent[],
  wrkq: CollaborationMessage[]
): Array<
  { source: 'hrc'; value: HrcLifecycleEvent } | { source: 'wrkq'; value: CollaborationMessage }
> {
  const result: Array<
    { source: 'hrc'; value: HrcLifecycleEvent } | { source: 'wrkq'; value: CollaborationMessage }
  > = []
  let hi = 0
  let wi = 0
  while (hi < hrc.length || wi < wrkq.length) {
    const he = hrc[hi]
    const wm = wrkq[wi]
    if (he === undefined) {
      result.push({ source: 'wrkq', value: wm as CollaborationMessage })
      wi += 1
      continue
    }
    if (wm === undefined) {
      result.push({ source: 'hrc', value: he })
      hi += 1
      continue
    }
    if (
      compareClosedInputs(
        { source: 'hrc', seq: he.hrcSeq, ts: he.ts },
        { source: 'wrkq', seq: wm.messageSeq, ts: wm.createdAt }
      ) <= 0
    ) {
      result.push({ source: 'hrc', value: he })
      hi += 1
    } else {
      result.push({ source: 'wrkq', value: wm })
      wi += 1
    }
  }
  return result
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function cursorDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * The exclusive frontier that keeps a captured head reachable when a cohort
 * consumed no row from that producer. Head 0 (an empty ledger) yields 1.
 */
function frontierAboveHead(head: number, source: 'hrc' | 'wrkq'): number {
  if (!Number.isSafeInteger(head) || head < 0) {
    throw new MobileTimelineSourcePositionExhaustedError(
      `${source} producer head ${head} is not a representable source position`
    )
  }
  if (head >= Number.MAX_SAFE_INTEGER) {
    throw new MobileTimelineSourcePositionExhaustedError(
      `${source} producer head reached the representable source-position ceiling`
    )
  }
  return head + 1
}

function parseCursor(token: string): CursorPayload {
  if (
    token.length === 0 ||
    Buffer.byteLength(token, 'utf8') > MAX_CURSOR_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    throw new MobileTimelineMalformedCursorError('history cursor encoding is malformed')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new MobileTimelineMalformedCursorError('history cursor payload is malformed')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new MobileTimelineMalformedCursorError('history cursor payload must be an object')
  }
  const value = parsed as Record<string, unknown>
  // Version and type are fenced before shape so a retired v1 cursor is refused
  // as an invalid cursor rather than reported as malformed encoding.
  if (value['v'] !== CURSOR_VERSION || value['type'] !== CURSOR_TYPE) {
    throw new MobileTimelineCursorInvalidError('history cursor type or version is retired')
  }
  const keys = [
    'beforeHrcSeq',
    'beforeMessageSeq',
    'beforeTimelineOrdinal',
    'generation',
    'hostSessionId',
    'hrcLedgerIncarnationId',
    'originTimelineOrdinal',
    'projectionEpoch',
    'sessionRef',
    'type',
    'v',
    'wrkqLedgerIncarnationId',
  ].sort()
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) {
    throw new MobileTimelineMalformedCursorError('history cursor fields are malformed')
  }
  if (
    typeof value['sessionRef'] !== 'string' ||
    typeof value['hostSessionId'] !== 'string' ||
    typeof value['generation'] !== 'number' ||
    typeof value['hrcLedgerIncarnationId'] !== 'string' ||
    typeof value['wrkqLedgerIncarnationId'] !== 'string' ||
    typeof value['projectionEpoch'] !== 'string' ||
    typeof value['originTimelineOrdinal'] !== 'string' ||
    typeof value['beforeTimelineOrdinal'] !== 'string' ||
    typeof value['beforeHrcSeq'] !== 'number' ||
    typeof value['beforeMessageSeq'] !== 'number'
  ) {
    throw new MobileTimelineCursorInvalidError('history cursor type, version, or fence is invalid')
  }
  const payload = value as unknown as CursorPayload
  if (
    !Number.isSafeInteger(payload.generation) ||
    payload.generation < 0 ||
    !Number.isSafeInteger(payload.beforeHrcSeq) ||
    payload.beforeHrcSeq < 0 ||
    !Number.isSafeInteger(payload.beforeMessageSeq) ||
    payload.beforeMessageSeq < 0 ||
    !/^-?(0|[1-9]\d*)$/.test(payload.originTimelineOrdinal) ||
    !/^-?(0|[1-9]\d*)$/.test(payload.beforeTimelineOrdinal) ||
    encodeCursor(payload) !== token
  ) {
    throw new MobileTimelineCursorInvalidError('history cursor is non-canonical or out of range')
  }
  return payload
}

export function createMobileTimelineProjector(deps: ProjectorDeps) {
  const queues = new Map<string, Promise<unknown>>()

  function serialize<T>(
    identity: MobileTimelineProjectionIdentity,
    work: () => Promise<T>
  ): Promise<T> {
    const key = `${identity.sessionRef}\u0000${identity.hostSessionId}\u0000${identity.generation}`
    const previous = queues.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(work)
    queues.set(key, current)
    return current.finally(() => {
      if (queues.get(key) === current) queues.delete(key)
    })
  }

  function mergeClosed(
    sources: Pick<ClosedSources, 'hrc' | 'wrkq' | 'hrcIncarnation' | 'wrkqIncarnation'>
  ): MergedRow[] {
    const rows: MergedRow[] = []
    const matchedByHrcSeq = new Map<number, CollaborationMessage>()
    const suppressedMessageIds = new Set<string>()
    if (deps.collaborationMatchesHrc !== undefined) {
      for (const event of sources.hrc) {
        const match = sources.wrkq.find(
          (message) =>
            !suppressedMessageIds.has(message.messageId) &&
            deps.collaborationMatchesHrc?.(event, message) === true
        )
        if (match !== undefined) {
          matchedByHrcSeq.set(event.hrcSeq, match)
          suppressedMessageIds.add(match.messageId)
        }
      }
    }
    for (const item of stableClosedMerge(sources.hrc, sources.wrkq)) {
      if (item.source === 'hrc') {
        const projected = deps.projectHrc(item.value, matchedByHrcSeq.get(item.value.hrcSeq))
        rows.push({
          source: 'hrc',
          seq: item.value.hrcSeq,
          rawBytes: encodedBytes(item.value),
          atom:
            projected === undefined
              ? undefined
              : {
                  ...projected,
                  atomId: `hrc:${sources.hrcIncarnation}:${item.value.hrcSeq}`,
                  sourceKind: 'hrc',
                  sourceSeq: item.value.hrcSeq,
                  sourceTs: item.value.ts,
                },
        })
        continue
      }
      const projected = suppressedMessageIds.has(item.value.messageId)
        ? undefined
        : deps.projectCollaboration(item.value)
      rows.push({
        source: 'wrkq',
        seq: item.value.messageSeq,
        rawBytes: encodedBytes(item.value),
        atom:
          projected === undefined
            ? undefined
            : {
                ...projected,
                atomId: `wrkq:${sources.wrkqIncarnation}:${item.value.messageId}:${item.value.messageSeq}`,
                sourceKind: 'wrkq',
                sourceSeq: item.value.messageSeq,
                sourceTs: item.value.createdAt,
              },
      })
    }
    return rows
  }

  /**
   * Consumes raw rows newest-first under the record/byte ceilings until the
   * target atom count is met. Every consumed row counts as scan progress,
   * whether or not it produced an atom.
   */
  function selectNewest(
    rows: MergedRow[],
    config: ProjectorOptions,
    budget: ScanBudget
  ): Selection {
    const atoms: MobileTimelineAtomInput[] = []
    let hrcConsumed = 0
    let wrkqConsumed = 0
    let hrcLowestConsumedSeq: number | undefined
    let wrkqLowestConsumedSeq: number | undefined
    let ceilingReached = false
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index] as MergedRow
      const atomBytes = row.atom === undefined ? 0 : encodedBytes(row.atom)
      if (atomBytes > config.maxBytes) {
        throw new MobileTimelineItemOversizeError('timeline atom is oversize')
      }
      if (row.atom !== undefined && atoms.length >= config.target) break
      if (
        budget.records + 1 > config.maxAtoms ||
        budget.bytes + row.rawBytes + atomBytes > config.maxBytes
      ) {
        ceilingReached = true
        break
      }
      budget.records += 1
      budget.bytes += row.rawBytes + atomBytes
      if (row.atom !== undefined) atoms.push(row.atom)
      if (row.source === 'hrc') {
        hrcConsumed += 1
        hrcLowestConsumedSeq = row.seq
      } else {
        wrkqConsumed += 1
        wrkqLowestConsumedSeq = row.seq
      }
    }
    return {
      atoms: atoms.reverse(),
      hrcConsumed,
      wrkqConsumed,
      hrcLowestConsumedSeq,
      wrkqLowestConsumedSeq,
      ceilingReached,
    }
  }

  async function recentSources(
    identity: MobileTimelineProjectorIdentity,
    config: ProjectorOptions
  ): Promise<ClosedSources> {
    const readLimit = Math.min(PRODUCER_PAGE_LIMIT, config.maxAtoms, Math.max(config.target, 1))
    const [hrc, wrkq] = await Promise.all([
      deps.hrcClient.tailEvents({
        limit: readLimit,
        hostSessionId: identity.hostSessionId,
        generation: identity.generation,
      }),
      deps.collaborationLedger.pageMessagesByMember({
        memberRef: identity.memberRef,
        beforeMessageSeq: Number.MAX_SAFE_INTEGER,
        limit: readLimit,
      }),
    ])
    return {
      hrc: hrc.events,
      wrkq: wrkq.messages,
      hrcIncarnation: hrc.ledgerIncarnationId,
      wrkqIncarnation: wrkq.ledgerIncarnationId,
      hrcHead: hrc.headHrcSeq,
      wrkqHead: wrkq.headMessageSeq,
      hrcHasMoreBefore: hrc.truncated,
      wrkqHasMoreBefore: wrkq.hasMoreBefore,
    }
  }

  function cursorFor(projection: MobileTimelineProjectionRecord, beforeOrdinal: string): string {
    return encodeCursor({
      v: CURSOR_VERSION,
      type: CURSOR_TYPE,
      sessionRef: projection.sessionRef,
      hostSessionId: projection.hostSessionId,
      generation: projection.generation,
      hrcLedgerIncarnationId: projection.hrcLedgerIncarnationId,
      wrkqLedgerIncarnationId: projection.wrkqLedgerIncarnationId,
      projectionEpoch: projection.projectionEpoch,
      originTimelineOrdinal: projection.originTimelineOrdinal,
      beforeTimelineOrdinal: beforeOrdinal,
      beforeHrcSeq: projection.hrcBeforeSeq,
      beforeMessageSeq: projection.messageBeforeSeq,
    })
  }

  /**
   * `boundary` is the exclusive epoch coordinate this response was read at. It
   * survives a zero-atom page, so an initial cohort that projected nothing
   * still mints a valid origin-anchored older cursor.
   */
  function response(
    projection: MobileTimelineProjectionRecord,
    atoms: MobileTimelineAtomRecord[],
    boundary: string,
    resetReason?: string
  ): MobileTimelinePage {
    const nextBoundary = atoms[0]?.timelineOrdinal ?? boundary
    const committedOlder = deps.store.listBefore(projection.projectionEpoch, nextBoundary, 1)
    const hasMoreBefore =
      committedOlder.length > 0 || !projection.hrcExhaustedBefore || !projection.wrkqExhaustedBefore
    return {
      projectionEpoch: projection.projectionEpoch,
      atoms,
      olderCursor: hasMoreBefore ? cursorFor(projection, nextBoundary) : null,
      hasMoreBefore,
      highWater: { hrcSeq: projection.hrcNewestSeq, messageSeq: projection.messageNewestSeq },
      ...(resetReason !== undefined ? { resetReason } : {}),
    }
  }

  async function replaceFromRecent(
    identity: MobileTimelineProjectorIdentity,
    config: ProjectorOptions,
    sources: ClosedSources,
    resetReason?: string
  ): Promise<MobileTimelinePage> {
    const selection = selectNewest(mergeClosed(sources), config, { records: 0, bytes: 0 })
    const replaced = deps.store.replaceEpoch({
      identity,
      hrcLedgerIncarnationId: sources.hrcIncarnation,
      wrkqLedgerIncarnationId: sources.wrkqIncarnation,
      hrcBeforeSeq: selection.hrcLowestConsumedSeq ?? frontierAboveHead(sources.hrcHead, 'hrc'),
      hrcNewestSeq: sources.hrcHead,
      messageBeforeSeq:
        selection.wrkqLowestConsumedSeq ?? frontierAboveHead(sources.wrkqHead, 'wrkq'),
      messageNewestSeq: sources.wrkqHead,
      hrcExhaustedBefore: !sources.hrcHasMoreBefore && selection.hrcConsumed === sources.hrc.length,
      wrkqExhaustedBefore:
        !sources.wrkqHasMoreBefore && selection.wrkqConsumed === sources.wrkq.length,
      ...(resetReason !== undefined ? { resetReason } : {}),
      atoms: selection.atoms,
    })
    return response(
      replaced.projection,
      replaced.atoms,
      replaced.projection.originTimelineOrdinal,
      resetReason
    )
  }

  async function hrcAfter(
    identity: MobileTimelineProjectorIdentity,
    projection: MobileTimelineProjectionRecord,
    head: number,
    max: number
  ) {
    const events: HrcLifecycleEvent[] = []
    let before = head + 1
    let incarnation = projection.hrcLedgerIncarnationId
    while (before > projection.hrcNewestSeq + 1 && events.length <= max) {
      const page = await deps.hrcClient.tailEvents({
        limit: Math.min(PRODUCER_PAGE_LIMIT, max + 1 - events.length),
        beforeHrcSeq: before,
        ledgerIncarnationId: incarnation,
        hostSessionId: identity.hostSessionId,
        generation: identity.generation,
      })
      incarnation = page.ledgerIncarnationId
      const newer = page.events.filter((item) => item.hrcSeq > projection.hrcNewestSeq)
      events.unshift(...newer)
      const oldest = page.events[0]?.hrcSeq
      if (oldest === undefined || oldest <= projection.hrcNewestSeq || !page.truncated) break
      before = oldest
    }
    return events.sort((lhs, rhs) => lhs.hrcSeq - rhs.hrcSeq)
  }

  async function wrkqAfter(
    identity: MobileTimelineProjectorIdentity,
    projection: MobileTimelineProjectionRecord,
    head: number,
    max: number
  ) {
    const messages: CollaborationMessage[] = []
    let after = projection.messageNewestSeq
    while (after < head && messages.length <= max) {
      const page = await deps.collaborationLedger.pageMessagesByMember({
        memberRef: identity.memberRef,
        afterMessageSeq: after,
        expectedLedgerIncarnationId: projection.wrkqLedgerIncarnationId,
        limit: Math.min(PRODUCER_PAGE_LIMIT, max + 1 - messages.length),
      })
      messages.push(...page.messages)
      const newest = page.messages.at(-1)?.messageSeq
      if (newest === undefined || !page.hasMoreAfter) break
      after = newest
    }
    return messages
  }

  async function openUnlocked(identity: MobileTimelineProjectorIdentity, config: ProjectorOptions) {
    const sources = await recentSources(identity, config)
    let active: MobileTimelineProjectionRecord | undefined
    try {
      active = deps.store.getActive(identity)
    } catch (error) {
      if (error instanceof MobileTimelineProjectionCorruptError) {
        return replaceFromRecent(identity, config, sources, 'projection_corrupt')
      }
      throw error
    }
    if (active === undefined) return replaceFromRecent(identity, config, sources)
    if (
      active.hrcLedgerIncarnationId !== sources.hrcIncarnation ||
      active.wrkqLedgerIncarnationId !== sources.wrkqIncarnation
    ) {
      return replaceFromRecent(identity, config, sources, 'producer_incarnation_changed')
    }
    const [hrc, wrkq] = await Promise.all([
      hrcAfter(identity, active, sources.hrcHead, config.maxAtoms),
      wrkqAfter(identity, active, sources.wrkqHead, config.maxAtoms),
    ])
    const staged = [
      ...hrc.map((value) => ({ source: 'hrc' as const, value })),
      ...wrkq.map((value) => ({ source: 'wrkq' as const, value })),
    ]
    const atoms: MobileTimelineAtomInput[] = []
    for (const item of staged) {
      if (item.source === 'hrc') {
        const projected = deps.projectHrc(item.value)
        if (projected !== undefined) {
          atoms.push({
            ...projected,
            atomId: `hrc:${sources.hrcIncarnation}:${item.value.hrcSeq}`,
            sourceKind: 'hrc',
            sourceSeq: item.value.hrcSeq,
            sourceTs: item.value.ts,
          })
        }
      } else {
        const projected = deps.projectCollaboration(item.value)
        if (projected !== undefined) {
          atoms.push({
            ...projected,
            atomId: `wrkq:${sources.wrkqIncarnation}:${item.value.messageId}:${item.value.messageSeq}`,
            sourceKind: 'wrkq',
            sourceSeq: item.value.messageSeq,
            sourceTs: item.value.createdAt,
          })
        }
      }
    }
    const projectedBytes = atoms.reduce((sum, item) => {
      const size = encodedBytes(item)
      if (size > config.maxBytes)
        throw new MobileTimelineItemOversizeError('timeline atom is oversize')
      return sum + size
    }, 0)
    const sourceBytes = staged.reduce((sum, item) => sum + encodedBytes(item.value), 0)
    if (
      hrc.length + wrkq.length > config.maxAtoms ||
      atoms.length > config.maxAtoms ||
      sourceBytes + projectedBytes > config.maxBytes
    ) {
      return replaceFromRecent(identity, config, sources, 'catch_up_limit_exceeded')
    }
    // Forward admission moves only the producer high-waters; a reverse frontier
    // and the epoch origin are untouched, so a pending historical head stays
    // eligible for the next older scan.
    const appended = deps.store.appendAtoms({
      projectionEpoch: active.projectionEpoch,
      atoms,
      hrcNewestSeq: sources.hrcHead,
      messageNewestSeq: sources.wrkqHead,
    })
    return response(
      appended.projection,
      deps.store.listNewest(active.projectionEpoch, config.target),
      appended.projection.originTimelineOrdinal
    )
  }

  async function olderSources(
    identity: MobileTimelineProjectorIdentity,
    projection: MobileTimelineProjectionRecord,
    limit: number
  ): Promise<ClosedSources> {
    const [hrc, wrkq] = await Promise.all([
      projection.hrcExhaustedBefore
        ? Promise.resolve<HrcEventTail>({
            events: [],
            ledgerIncarnationId: projection.hrcLedgerIncarnationId,
            headHrcSeq: projection.hrcNewestSeq,
            truncated: false,
          })
        : deps.hrcClient.tailEvents({
            limit,
            beforeHrcSeq: projection.hrcBeforeSeq,
            ledgerIncarnationId: projection.hrcLedgerIncarnationId,
            hostSessionId: identity.hostSessionId,
            generation: identity.generation,
          }),
      projection.wrkqExhaustedBefore
        ? Promise.resolve<CollaborationMessagePage>({
            ledgerIncarnationId: projection.wrkqLedgerIncarnationId,
            headMessageSeq: projection.messageNewestSeq,
            hasMoreBefore: false,
            hasMoreAfter: false,
            messages: [],
          })
        : deps.collaborationLedger.pageMessagesByMember({
            memberRef: identity.memberRef,
            beforeMessageSeq: projection.messageBeforeSeq,
            expectedLedgerIncarnationId: projection.wrkqLedgerIncarnationId,
            limit,
          }),
    ])
    return {
      hrc: hrc.events,
      wrkq: wrkq.messages,
      hrcIncarnation: hrc.ledgerIncarnationId,
      wrkqIncarnation: wrkq.ledgerIncarnationId,
      hrcHead: hrc.headHrcSeq,
      wrkqHead: wrkq.headMessageSeq,
      hrcHasMoreBefore: hrc.truncated,
      wrkqHasMoreBefore: wrkq.hasMoreBefore,
    }
  }

  function decodeAndValidateCursor(
    token: string,
    identity: MobileTimelineProjectorIdentity
  ): CursorPayload {
    const payload = parseCursor(token)
    let active: MobileTimelineProjectionRecord | undefined
    try {
      active = deps.store.getActive(identity)
    } catch (error) {
      if (error instanceof MobileTimelineProjectionCorruptError) {
        throw new MobileTimelineCursorInvalidError('history projection is corrupt and must reset')
      }
      throw error
    }
    if (
      payload.sessionRef !== identity.sessionRef ||
      payload.hostSessionId !== identity.hostSessionId ||
      payload.generation !== identity.generation ||
      active === undefined ||
      payload.projectionEpoch !== active.projectionEpoch ||
      payload.hrcLedgerIncarnationId !== active.hrcLedgerIncarnationId ||
      payload.wrkqLedgerIncarnationId !== active.wrkqLedgerIncarnationId ||
      payload.originTimelineOrdinal !== active.originTimelineOrdinal ||
      !isBoundary(active, payload.beforeTimelineOrdinal) ||
      // Reverse frontiers only ever move older, so a live cursor never sits
      // below the epoch's current frontier; the exclusive upper sentinel is
      // the canonical no-row-consumed state at the producer head.
      payload.beforeHrcSeq < active.hrcBeforeSeq ||
      payload.beforeHrcSeq > active.hrcNewestSeq + 1 ||
      payload.beforeMessageSeq < active.messageBeforeSeq ||
      payload.beforeMessageSeq > active.messageNewestSeq + 1
    ) {
      throw new MobileTimelineCursorInvalidError('history cursor fence is no longer current')
    }
    return payload
  }

  /** A boundary names either the persisted epoch origin or a committed atom. */
  function isBoundary(active: MobileTimelineProjectionRecord, value: string): boolean {
    if (value === active.originTimelineOrdinal) return true
    if (active.minTimelineOrdinal === null || active.maxTimelineOrdinal === null) return false
    const candidate = BigInt(value)
    if (
      candidate < BigInt(active.minTimelineOrdinal) ||
      candidate > BigInt(active.maxTimelineOrdinal)
    ) {
      return false
    }
    return deps.store.hasOrdinal(active.projectionEpoch, value)
  }

  function replayReceipt(receipt: MobileTimelinePageReceipt): MobileTimelinePage {
    const atoms = deps.store.listByAtomIds(receipt.projectionEpoch, receipt.atomIds)
    atoms.forEach((atom, index) => {
      if (atom.timelineOrdinal !== receipt.timelineOrdinals[index]) {
        throw new MobileTimelineProjectionCorruptError(
          `page receipt atom ${atom.atomId} renumbered from ${receipt.timelineOrdinals[index]} to ${atom.timelineOrdinal}`
        )
      }
    })
    return {
      projectionEpoch: receipt.projectionEpoch,
      atoms,
      olderCursor: receipt.olderCursor,
      hasMoreBefore: receipt.hasMoreBefore,
      highWater: {
        hrcSeq: receipt.highWaterHrcSeq,
        messageSeq: receipt.highWaterMessageSeq,
      },
      ...(receipt.resetReason !== null ? { resetReason: receipt.resetReason } : {}),
    }
  }

  async function pageUnlocked(
    identity: MobileTimelineProjectorIdentity,
    token: string,
    config: ProjectorOptions
  ): Promise<MobileTimelinePage> {
    const cursor = decodeAndValidateCursor(token, identity)
    let projection = deps.store.getActive(identity) as MobileTimelineProjectionRecord
    const receiptKey = {
      projectionEpoch: projection.projectionEpoch,
      requestDigest: cursorDigest(token),
      requestedLimit: config.target,
      responseContractVersion: MOBILE_HISTORY_RESPONSE_CONTRACT_VERSION,
    }
    const recorded = deps.store.getPageReceipt(receiptKey)
    if (recorded !== undefined) return replayReceipt(recorded)

    const boundary = cursor.beforeTimelineOrdinal
    let atoms = deps.store.listBefore(projection.projectionEpoch, boundary, config.target)
    const budget: ScanBudget = { records: 0, bytes: 0 }
    while (
      atoms.length < config.target &&
      (!projection.hrcExhaustedBefore || !projection.wrkqExhaustedBefore) &&
      budget.records < config.maxAtoms &&
      budget.bytes < config.maxBytes
    ) {
      const readLimit = Math.min(PRODUCER_PAGE_LIMIT, config.target)
      const sources = await olderSources(identity, projection, readLimit)
      const selection = selectNewest(
        mergeClosed(sources),
        { ...config, target: config.target - atoms.length },
        budget
      )
      const prepended = deps.store.prependAtoms({
        projectionEpoch: projection.projectionEpoch,
        atoms: selection.atoms,
        hrcBeforeSeq: selection.hrcLowestConsumedSeq ?? projection.hrcBeforeSeq,
        messageBeforeSeq: selection.wrkqLowestConsumedSeq ?? projection.messageBeforeSeq,
        // Exhaustion follows raw-row consumption, never selected-atom counts:
        // a producer that returned rows nobody projected is not exhausted.
        hrcExhaustedBefore:
          !sources.hrcHasMoreBefore && selection.hrcConsumed === sources.hrc.length,
        wrkqExhaustedBefore:
          !sources.wrkqHasMoreBefore && selection.wrkqConsumed === sources.wrkq.length,
      })
      projection = prepended.projection
      atoms = deps.store.listBefore(projection.projectionEpoch, boundary, config.target)
      if (selection.ceilingReached) break
      // No raw row was consumable this round; another identical read would only
      // repeat it, so the request ends bounded rather than looping.
      if (selection.hrcConsumed === 0 && selection.wrkqConsumed === 0) break
    }

    const page = response(projection, atoms, boundary)
    deps.store.putPageReceipt({
      ...receiptKey,
      boundaryTimelineOrdinal: boundary,
      atomIds: page.atoms.map((atom) => atom.atomId),
      timelineOrdinals: page.atoms.map((atom) => atom.timelineOrdinal),
      olderCursor: page.olderCursor,
      hasMoreBefore: page.hasMoreBefore,
      highWaterHrcSeq: page.highWater.hrcSeq,
      highWaterMessageSeq: page.highWater.messageSeq,
      resetReason: page.resetReason ?? null,
    })
    return page
  }

  async function admitLiveHrcUnlocked(
    identity: MobileTimelineProjectorIdentity,
    event: HrcLifecycleEvent,
    matchedCollaboration?: CollaborationMessage | undefined
  ): Promise<MobileTimelineAtomRecord[]> {
    const projection = deps.store.getActive(identity)
    if (projection === undefined) {
      throw new MobileTimelineCursorInvalidError('timeline projection is not open')
    }
    const projected = deps.projectHrc(event, matchedCollaboration)
    const atoms: MobileTimelineAtomInput[] =
      projected === undefined
        ? []
        : [
            {
              ...projected,
              atomId: `hrc:${projection.hrcLedgerIncarnationId}:${event.hrcSeq}`,
              sourceKind: 'hrc',
              sourceSeq: event.hrcSeq,
              sourceTs: event.ts,
            },
          ]
    return deps.store.appendAtoms({
      projectionEpoch: projection.projectionEpoch,
      atoms,
      hrcNewestSeq: Math.max(projection.hrcNewestSeq, event.hrcSeq),
      messageNewestSeq: projection.messageNewestSeq,
    }).inserted
  }

  async function admitLiveCollaborationUnlocked(
    identity: MobileTimelineProjectorIdentity,
    message: CollaborationMessage,
    suppressAtom: boolean
  ): Promise<MobileTimelineAtomRecord[]> {
    const projection = deps.store.getActive(identity)
    if (projection === undefined) {
      throw new MobileTimelineCursorInvalidError('timeline projection is not open')
    }
    const projected = suppressAtom ? undefined : deps.projectCollaboration(message)
    const atoms: MobileTimelineAtomInput[] =
      projected === undefined
        ? []
        : [
            {
              ...projected,
              atomId: `wrkq:${projection.wrkqLedgerIncarnationId}:${message.messageId}:${message.messageSeq}`,
              sourceKind: 'wrkq',
              sourceSeq: message.messageSeq,
              sourceTs: message.createdAt,
            },
          ]
    return deps.store.appendAtoms({
      projectionEpoch: projection.projectionEpoch,
      atoms,
      hrcNewestSeq: projection.hrcNewestSeq,
      messageNewestSeq: Math.max(projection.messageNewestSeq, message.messageSeq),
    }).inserted
  }

  return {
    open(identity: MobileTimelineProjectorIdentity, input: Partial<ProjectorOptions> = {}) {
      const config = options(input)
      return serialize(identity, () => openUnlocked(identity, config))
    },

    page(
      identity: MobileTimelineProjectorIdentity,
      token: string,
      input: Partial<ProjectorOptions> = {}
    ) {
      const config = options(input)
      return serialize(identity, () => pageUnlocked(identity, token, config))
    },

    decodeAndValidateCursor,

    admitLiveHrc(
      identity: MobileTimelineProjectorIdentity,
      event: HrcLifecycleEvent,
      matchedCollaboration?: CollaborationMessage | undefined
    ) {
      return serialize(identity, () => admitLiveHrcUnlocked(identity, event, matchedCollaboration))
    },

    admitLiveCollaboration(
      identity: MobileTimelineProjectorIdentity,
      message: CollaborationMessage,
      input: { suppressAtom?: boolean | undefined } = {}
    ) {
      return serialize(identity, () =>
        admitLiveCollaborationUnlocked(identity, message, input.suppressAtom === true)
      )
    },
  }
}
