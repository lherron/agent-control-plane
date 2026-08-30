import type {
  MobileTimelineAtomInput,
  MobileTimelineAtomRecord,
  MobileTimelineProjectionIdentity,
  MobileTimelineProjectionRecord,
  MobileTimelineProjectionRepo,
} from 'acp-state-store'
import type { HrcLifecycleEvent } from 'hrc-core'
import type { HrcEventTail } from 'hrc-sdk'
import type { CollaborationLedger, CollaborationMessage, CollaborationMessagePage } from 'wrkq-lib'

const DEFAULT_TARGET = 50
const MAX_TARGET = 100
const DEFAULT_MAX_ATOMS = 2_048
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024
const PRODUCER_PAGE_LIMIT = 500
const CURSOR_VERSION = 1
const CURSOR_TYPE = 'mobile_history'
const MAX_CURSOR_BYTES = 4_096

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

type CursorPayload = {
  v: 1
  type: 'mobile_history'
  sessionRef: string
  hostSessionId: string
  generation: number
  hrcLedgerIncarnationId: string
  wrkqLedgerIncarnationId: string
  projectionEpoch: string
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
  const keys = [
    'beforeHrcSeq',
    'beforeMessageSeq',
    'beforeTimelineOrdinal',
    'generation',
    'hostSessionId',
    'hrcLedgerIncarnationId',
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
    value['v'] !== CURSOR_VERSION ||
    value['type'] !== CURSOR_TYPE ||
    typeof value['sessionRef'] !== 'string' ||
    typeof value['hostSessionId'] !== 'string' ||
    typeof value['generation'] !== 'number' ||
    typeof value['hrcLedgerIncarnationId'] !== 'string' ||
    typeof value['wrkqLedgerIncarnationId'] !== 'string' ||
    typeof value['projectionEpoch'] !== 'string' ||
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

  function projectClosed(
    sources: Pick<ClosedSources, 'hrc' | 'wrkq' | 'hrcIncarnation' | 'wrkqIncarnation'>
  ) {
    const atoms: MobileTimelineAtomInput[] = []
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
        if (suppressedMessageIds.has(item.value.messageId)) continue
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
    return atoms
  }

  function boundedNewest(atoms: MobileTimelineAtomInput[], config: ProjectorOptions) {
    const selected: MobileTimelineAtomInput[] = []
    let bytes = 0
    for (let index = atoms.length - 1; index >= 0 && selected.length < config.target; index -= 1) {
      const item = atoms[index] as MobileTimelineAtomInput
      const itemBytes = encodedBytes(item)
      if (itemBytes > config.maxBytes)
        throw new MobileTimelineItemOversizeError('timeline atom is oversize')
      if (bytes + itemBytes > config.maxBytes || selected.length >= config.maxAtoms) break
      selected.push(item)
      bytes += itemBytes
    }
    return selected.reverse()
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
      beforeTimelineOrdinal: beforeOrdinal,
      beforeHrcSeq: projection.hrcOldestSeq,
      beforeMessageSeq: projection.messageOldestSeq,
    })
  }

  function response(
    projection: MobileTimelineProjectionRecord,
    atoms: MobileTimelineAtomRecord[],
    resetReason?: string
  ): MobileTimelinePage {
    const oldest = atoms[0]
    const committedOlder =
      oldest === undefined
        ? []
        : deps.store.listBefore(projection.projectionEpoch, oldest.timelineOrdinal, 1)
    const hasMoreBefore =
      committedOlder.length > 0 || !projection.hrcExhaustedBefore || !projection.wrkqExhaustedBefore
    return {
      projectionEpoch: projection.projectionEpoch,
      atoms,
      olderCursor:
        hasMoreBefore && oldest !== undefined
          ? cursorFor(projection, oldest.timelineOrdinal)
          : null,
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
    const atoms = boundedNewest(projectClosed(sources), config)
    const selectedHrc = atoms.filter((item) => item.sourceKind === 'hrc')
    const selectedWrkq = atoms.filter((item) => item.sourceKind === 'wrkq')
    const replaced = deps.store.replaceEpoch({
      identity,
      hrcLedgerIncarnationId: sources.hrcIncarnation,
      wrkqLedgerIncarnationId: sources.wrkqIncarnation,
      hrcOldestSeq: selectedHrc[0]?.sourceSeq ?? sources.hrcHead,
      hrcNewestSeq: sources.hrcHead,
      messageOldestSeq: selectedWrkq[0]?.sourceSeq ?? sources.wrkqHead,
      messageNewestSeq: sources.wrkqHead,
      hrcExhaustedBefore: !sources.hrcHasMoreBefore && selectedHrc.length === sources.hrc.length,
      wrkqExhaustedBefore:
        !sources.wrkqHasMoreBefore && selectedWrkq.length === sources.wrkq.length,
      ...(resetReason !== undefined ? { resetReason } : {}),
      atoms,
    })
    return response(replaced.projection, replaced.atoms, resetReason)
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
    const active = deps.store.getActive(identity)
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
    const appended = deps.store.appendAtoms({
      projectionEpoch: active.projectionEpoch,
      atoms,
      hrcNewestSeq: sources.hrcHead,
      messageNewestSeq: sources.wrkqHead,
    })
    return response(
      appended.projection,
      deps.store.listNewest(active.projectionEpoch, config.target)
    )
  }

  async function olderSources(
    identity: MobileTimelineProjectorIdentity,
    projection: MobileTimelineProjectionRecord,
    config: ProjectorOptions
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
            limit: Math.min(PRODUCER_PAGE_LIMIT, config.target),
            beforeHrcSeq: projection.hrcOldestSeq,
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
            beforeMessageSeq: projection.messageOldestSeq,
            expectedLedgerIncarnationId: projection.wrkqLedgerIncarnationId,
            limit: Math.min(PRODUCER_PAGE_LIMIT, config.target),
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
    const active = deps.store.getActive(identity)
    if (
      payload.sessionRef !== identity.sessionRef ||
      payload.hostSessionId !== identity.hostSessionId ||
      payload.generation !== identity.generation ||
      active === undefined ||
      payload.projectionEpoch !== active.projectionEpoch ||
      payload.hrcLedgerIncarnationId !== active.hrcLedgerIncarnationId ||
      payload.wrkqLedgerIncarnationId !== active.wrkqLedgerIncarnationId ||
      active.minTimelineOrdinal === null ||
      active.maxTimelineOrdinal === null ||
      BigInt(payload.beforeTimelineOrdinal) < BigInt(active.minTimelineOrdinal) ||
      BigInt(payload.beforeTimelineOrdinal) > BigInt(active.maxTimelineOrdinal) ||
      !deps.store.hasOrdinal(active.projectionEpoch, payload.beforeTimelineOrdinal) ||
      payload.beforeHrcSeq < active.hrcOldestSeq ||
      payload.beforeHrcSeq > active.hrcNewestSeq ||
      payload.beforeMessageSeq < active.messageOldestSeq ||
      payload.beforeMessageSeq > active.messageNewestSeq
    ) {
      throw new MobileTimelineCursorInvalidError('history cursor fence is no longer current')
    }
    return payload
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
      return serialize(identity, async () => {
        const cursor = decodeAndValidateCursor(token, identity)
        let projection = deps.store.getActive(identity) as MobileTimelineProjectionRecord
        let atoms = deps.store.listBefore(
          projection.projectionEpoch,
          cursor.beforeTimelineOrdinal,
          config.target
        )
        if (
          atoms.length < config.target &&
          (!projection.hrcExhaustedBefore || !projection.wrkqExhaustedBefore)
        ) {
          const sources = await olderSources(identity, projection, config)
          const selected = boundedNewest(projectClosed(sources), {
            ...config,
            target: config.target - atoms.length,
          })
          const selectedHrc = selected.filter((item) => item.sourceKind === 'hrc')
          const selectedWrkq = selected.filter((item) => item.sourceKind === 'wrkq')
          const prepended = deps.store.prependAtoms({
            projectionEpoch: projection.projectionEpoch,
            atoms: selected,
            hrcOldestSeq: selectedHrc[0]?.sourceSeq ?? projection.hrcOldestSeq,
            messageOldestSeq: selectedWrkq[0]?.sourceSeq ?? projection.messageOldestSeq,
            hrcExhaustedBefore:
              !sources.hrcHasMoreBefore && selectedHrc.length === sources.hrc.length,
            wrkqExhaustedBefore:
              !sources.wrkqHasMoreBefore && selectedWrkq.length === sources.wrkq.length,
          })
          projection = prepended.projection
          atoms = deps.store.listBefore(
            projection.projectionEpoch,
            cursor.beforeTimelineOrdinal,
            config.target
          )
        }
        return response(projection, atoms)
      })
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
