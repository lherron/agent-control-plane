import { describe, expect, test } from 'bun:test'
import { openAcpStateStore } from 'acp-state-store'
import type { HrcEventTail, HrcLifecycleEvent } from 'hrc-core'
import type { CollaborationMessage, CollaborationMessagePage } from 'wrkq-lib'

import {
  MobileTimelineCursorInvalidError,
  MobileTimelineItemOversizeError,
  MobileTimelineMalformedCursorError,
  MobileTimelineSourcePositionExhaustedError,
  createMobileTimelineProjector,
} from '../src/mobile-timeline-projector.js'

const IDENTITY = {
  sessionRef: 'agent:cody:project:agent-control-plane:task:T-07718/lane:main',
  hostSessionId: 'hsid-t07718-projector',
  generation: 4,
  memberRef: 'cody@agent-control-plane:T-07718',
}

function event(hrcSeq: number, text: string, ts: string, frame = 'assistant'): HrcLifecycleEvent {
  return {
    hrcSeq,
    streamSeq: hrcSeq,
    ts,
    hostSessionId: IDENTITY.hostSessionId,
    scopeRef: 'agent:cody:project:agent-control-plane:task:T-07718',
    laneRef: 'main',
    generation: IDENTITY.generation,
    category: 'turn',
    eventKind: 'turn.message',
    replayed: false,
    payload: { text, frame },
  }
}

/** A raw HRC row that is read and consumed but projects to no public atom. */
function nonProjecting(hrcSeq: number, ts: string): HrcLifecycleEvent {
  return event(hrcSeq, `noise ${hrcSeq}`, ts, 'noise')
}

function message(messageSeq: number, body: string, createdAt: string): CollaborationMessage {
  return {
    messageId: `EN-${String(messageSeq).padStart(5, '0')}`,
    messageSeq,
    roomKey: 'T-07718',
    groupId: `EN-${String(messageSeq).padStart(5, '0')}`,
    sender: { principalRef: 'agent:lance' },
    recipient: { principalRef: 'agent:cody', scopeRef: IDENTITY.memberRef },
    obligation: 'reply_required',
    state: 'pending',
    body,
    createdAt,
    updatedAt: createdAt,
  }
}

function fixture() {
  const events: HrcLifecycleEvent[] = []
  const messages: CollaborationMessage[] = []
  const reads = { hrc: 0, wrkq: 0 }
  let hrcIncarnation = 'hrc-a'
  let wrkqIncarnation = 'wrkq-a'
  const state = openAcpStateStore({ dbPath: ':memory:' })
  const projector = createMobileTimelineProjector({
    store: state.mobileTimeline,
    hrcClient: {
      async tailEvents(options): Promise<HrcEventTail> {
        reads.hrc += 1
        const matching = events.filter(
          (item) =>
            item.hostSessionId === options.hostSessionId &&
            item.generation === options.generation &&
            (options.beforeHrcSeq === undefined || item.hrcSeq < options.beforeHrcSeq)
        )
        const selected = matching.slice(-options.limit)
        return {
          events: selected,
          ledgerIncarnationId: hrcIncarnation,
          headHrcSeq: events.at(-1)?.hrcSeq ?? 0,
          truncated: matching.length > selected.length,
        }
      },
    },
    collaborationLedger: {
      async pageMessagesByMember(input): Promise<CollaborationMessagePage> {
        reads.wrkq += 1
        const matching = messages.filter(
          (item) =>
            (input.beforeMessageSeq === undefined || item.messageSeq < input.beforeMessageSeq) &&
            (input.afterMessageSeq === undefined || item.messageSeq > input.afterMessageSeq)
        )
        const selected =
          input.afterMessageSeq === undefined
            ? matching.slice(-input.limit)
            : matching.slice(0, input.limit)
        return {
          ledgerIncarnationId: wrkqIncarnation,
          headMessageSeq: messages.at(-1)?.messageSeq ?? 0,
          hasMoreBefore: matching.length > selected.length && input.beforeMessageSeq !== undefined,
          hasMoreAfter: matching.length > selected.length && input.afterMessageSeq !== undefined,
          messages: selected,
        }
      },
    },
    projectHrc(item) {
      const payload = item.payload as { text: string; frame: string }
      if (payload.frame === 'noise') return undefined
      return {
        logicalFrameId: payload.frame,
        operation: 'append',
        payload: { blocks: [{ kind: 'markdown', text: payload.text }] },
        prefixState: 'unknown',
      }
    },
    projectCollaboration(item) {
      return {
        logicalFrameId: `tool:${item.messageId}`,
        operation: 'append',
        payload: { blocks: [{ kind: 'markdown', text: item.body }] },
        prefixState: 'complete',
      }
    },
  })
  return {
    events,
    messages,
    projector,
    reads,
    state,
    replaceHrc: () => {
      hrcIncarnation = 'hrc-b'
    },
    replaceWrkq: () => {
      wrkqIncarnation = 'wrkq-b'
    },
  }
}

function decodeCursor(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<string, unknown>
}

function rewriteCursor(token: string, change: (value: Record<string, unknown>) => void): string {
  const value = decodeCursor(token)
  change(value)
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** Walks `olderCursor` to exhaustion and returns every atom oldest-first. */
async function walkOlder(
  fx: ReturnType<typeof fixture>,
  page: { atoms: Array<{ sourceKind: string; sourceSeq: number }>; olderCursor: string | null },
  target: number
) {
  const walked: Array<{ sourceKind: string; sourceSeq: number }> = [...page.atoms]
  let cursor = page.olderCursor
  for (let guard = 0; cursor !== null && guard < 50; guard += 1) {
    const older = await fx.projector.page(IDENTITY, cursor, { target })
    walked.unshift(...older.atoms)
    cursor = older.olderCursor
  }
  return walked.map((atom) => `${atom.sourceKind}:${atom.sourceSeq}`)
}

describe('mobile timeline projector', () => {
  test('admits one closed recent cohort with distinct A1/tool/A2 atom ordinals', async () => {
    const fx = fixture()
    try {
      fx.events.push(
        event(1, 'A1', '2026-08-30T01:00:01.000Z'),
        event(2, 'A2', '2026-08-30T01:00:03.000Z')
      )
      fx.messages.push(message(1, 'tool T', '2026-08-30T01:00:02.000Z'))

      const opened = await fx.projector.open(IDENTITY)
      expect(opened.atoms.map((item) => [item.payload.blocks, item.timelineOrdinal])).toEqual([
        [[{ kind: 'markdown', text: 'A1' }], '0'],
        [[{ kind: 'markdown', text: 'tool T' }], '1'],
        [[{ kind: 'markdown', text: 'A2' }], '2'],
      ])
      expect(opened.atoms.map((item) => item.logicalFrameId)).toEqual([
        'assistant',
        'tool:EN-00001',
        'assistant',
      ])
      expect(opened.resetReason).toBeUndefined()
    } finally {
      fx.state.close()
    }
  })

  // ── T-07728 ────────────────────────────────────────────────────────────────

  test('delivers the HRC head a wrkq-only first cohort selected none of', async () => {
    const fx = fixture()
    try {
      for (let seq = 1; seq <= 4; seq += 1) {
        fx.events.push(event(seq, `assistant ${seq}`, `2026-08-30T00:00:0${seq}.000Z`))
      }
      for (let seq = 1; seq <= 5; seq += 1) {
        fx.messages.push(message(seq, `envelope ${seq}`, `2026-08-30T01:00:0${seq}.000Z`))
      }

      const opened = await fx.projector.open(IDENTITY, { target: 3 })
      // The bounded newest window is entirely collaboration, so no HRC row was
      // consumed and the frontier must sit one above the captured head.
      expect(opened.atoms.map((atom) => atom.sourceKind)).toEqual(['wrkq', 'wrkq', 'wrkq'])
      expect(fx.state.mobileTimeline.getActive(IDENTITY)?.hrcBeforeSeq).toBe(5)

      expect(await walkOlder(fx, opened, 3)).toEqual([
        'hrc:1',
        'hrc:2',
        'hrc:3',
        'hrc:4',
        'wrkq:1',
        'wrkq:2',
        'wrkq:3',
        'wrkq:4',
        'wrkq:5',
      ])
    } finally {
      fx.state.close()
    }
  })

  test('delivers the collaboration head an HRC-only first cohort selected none of', async () => {
    const fx = fixture()
    try {
      for (let seq = 1; seq <= 4; seq += 1) {
        fx.messages.push(message(seq, `envelope ${seq}`, `2026-08-30T00:00:0${seq}.000Z`))
      }
      for (let seq = 1; seq <= 5; seq += 1) {
        fx.events.push(event(seq, `assistant ${seq}`, `2026-08-30T01:00:0${seq}.000Z`))
      }

      const opened = await fx.projector.open(IDENTITY, { target: 3 })
      expect(opened.atoms.map((atom) => atom.sourceKind)).toEqual(['hrc', 'hrc', 'hrc'])
      expect(fx.state.mobileTimeline.getActive(IDENTITY)?.messageBeforeSeq).toBe(5)

      expect(await walkOlder(fx, opened, 3)).toEqual([
        'wrkq:1',
        'wrkq:2',
        'wrkq:3',
        'wrkq:4',
        'hrc:1',
        'hrc:2',
        'hrc:3',
        'hrc:4',
        'hrc:5',
      ])
    } finally {
      fx.state.close()
    }
  })

  test('mints an origin-anchored cursor for an all-producers-zero-atom first cohort', async () => {
    const fx = fixture()
    try {
      fx.events.push(
        event(1, 'A1', '2026-08-30T01:00:01.000Z'),
        event(2, 'A2', '2026-08-30T01:00:02.000Z'),
        nonProjecting(3, '2026-08-30T01:00:03.000Z'),
        nonProjecting(4, '2026-08-30T01:00:04.000Z')
      )

      const opened = await fx.projector.open(IDENTITY, { target: 2 })
      expect(opened.atoms).toEqual([])
      expect(opened.hasMoreBefore).toBe(true)
      expect(opened.olderCursor).not.toBeNull()
      const fence = decodeCursor(opened.olderCursor as string)
      expect([fence['beforeTimelineOrdinal'], fence['originTimelineOrdinal']]).toEqual(['0', '0'])
      const active = fx.state.mobileTimeline.getActive(IDENTITY)
      expect(active?.minTimelineOrdinal).toBeNull()
      expect(active?.hrcBeforeSeq).toBe(3)

      const older = await fx.projector.page(IDENTITY, opened.olderCursor as string, { target: 2 })
      expect(older.atoms.map((atom) => [atom.sourceSeq, atom.timelineOrdinal])).toEqual([
        [1, '-2'],
        [2, '-1'],
      ])
      expect(older.resetReason).toBeUndefined()
    } finally {
      fx.state.close()
    }
  })

  test('advances frontiers through non-projecting rows and replays the zero-atom page', async () => {
    const fx = fixture()
    try {
      fx.events.push(event(1, 'A1', '2026-08-30T01:00:00.000Z'))
      for (let seq = 2; seq <= 20; seq += 1) {
        fx.events.push(nonProjecting(seq, `2026-08-30T01:00:${String(seq).padStart(2, '0')}.000Z`))
      }

      const opened = await fx.projector.open(IDENTITY, { target: 2, maxAtoms: 3 })
      expect(opened.atoms).toEqual([])
      const cursor = opened.olderCursor as string
      expect(decodeCursor(cursor)['beforeHrcSeq']).toBe(19)

      const continued = await fx.projector.page(IDENTITY, cursor, { target: 2, maxAtoms: 3 })
      // The record ceiling stops the scan before any atom is presentable: the
      // page is empty but the source vector moved and paging can continue.
      expect(continued.atoms).toEqual([])
      expect(continued.hasMoreBefore).toBe(true)
      expect(decodeCursor(continued.olderCursor as string)['beforeHrcSeq']).toBe(16)
      expect(decodeCursor(continued.olderCursor as string)['beforeTimelineOrdinal']).toBe('0')

      const readsAfterFirst = { ...fx.reads }
      const replay = await fx.projector.page(IDENTITY, cursor, { target: 2, maxAtoms: 3 })
      expect(replay).toEqual(continued)
      expect(fx.reads).toEqual(readsAfterFirst)
      expect(fx.state.mobileTimeline.getActive(IDENTITY)?.hrcBeforeSeq).toBe(16)
    } finally {
      fx.state.close()
    }
  })

  test('keeps one cursor at two limits on separate receipts, each within its own bound', async () => {
    for (const order of [
      [100, 1],
      [1, 100],
    ]) {
      const fx = fixture()
      try {
        for (let seq = 1; seq <= 6; seq += 1) {
          fx.events.push(event(seq, `assistant ${seq}`, `2026-08-30T01:00:0${seq}.000Z`))
        }
        const opened = await fx.projector.open(IDENTITY, { target: 2 })
        const cursor = opened.olderCursor as string
        const [firstLimit, secondLimit] = order as [number, number]

        const first = await fx.projector.page(IDENTITY, cursor, { target: firstLimit })
        expect(first.atoms.length).toBeLessThanOrEqual(firstLimit)
        const second = await fx.projector.page(IDENTITY, cursor, { target: secondLimit })
        expect(second.atoms.length).toBeLessThanOrEqual(secondLimit)
        expect(second.atoms.length).not.toBe(first.atoms.length)

        const readsAfter = { ...fx.reads }
        expect(await fx.projector.page(IDENTITY, cursor, { target: firstLimit })).toEqual(first)
        expect(await fx.projector.page(IDENTITY, cursor, { target: secondLimit })).toEqual(second)
        expect(fx.reads).toEqual(readsAfter)
      } finally {
        fx.state.close()
      }
    }
  })

  test('leaves reverse frontiers and pre-live receipts untouched by live arrivals', async () => {
    const fx = fixture()
    try {
      for (let seq = 1; seq <= 6; seq += 1) {
        fx.events.push(event(seq, `assistant ${seq}`, `2026-08-30T01:00:0${seq}.000Z`))
      }
      const opened = await fx.projector.open(IDENTITY, { target: 2 })
      const cursor = opened.olderCursor as string
      const paged = await fx.projector.page(IDENTITY, cursor, { target: 2 })
      const frontierBefore = fx.state.mobileTimeline.getActive(IDENTITY)

      const live = event(7, 'live', '2026-08-30T01:00:07.000Z')
      fx.events.push(live)
      const admitted = await fx.projector.admitLiveHrc(IDENTITY, live)
      expect(admitted.map((atom) => atom.sourceSeq)).toEqual([7])

      const after = fx.state.mobileTimeline.getActive(IDENTITY)
      expect(after?.hrcBeforeSeq).toBe(frontierBefore?.hrcBeforeSeq)
      expect(after?.messageBeforeSeq).toBe(frontierBefore?.messageBeforeSeq)
      expect(after?.originTimelineOrdinal).toBe(frontierBefore?.originTimelineOrdinal)
      expect(after?.hrcNewestSeq).toBe(7)

      const replay = await fx.projector.page(IDENTITY, cursor, { target: 2 })
      expect(replay).toEqual(paged)
      expect(replay.atoms.some((atom) => atom.sourceSeq === 7)).toBe(false)
    } finally {
      fx.state.close()
    }
  })

  test('refuses retired v1 cursors and source positions outside the frontier range', async () => {
    const fx = fixture()
    try {
      for (let seq = 1; seq <= 4; seq += 1) {
        fx.events.push(event(seq, `assistant ${seq}`, `2026-08-30T01:00:0${seq}.000Z`))
      }
      const opened = await fx.projector.open(IDENTITY, { target: 2 })
      const cursor = opened.olderCursor as string
      const payload = decodeCursor(cursor)

      const { originTimelineOrdinal: _retired, ...withoutOrigin } = payload
      const legacy = { ...withoutOrigin, v: 1 }
      expect(() =>
        fx.projector.decodeAndValidateCursor(
          Buffer.from(JSON.stringify(legacy), 'utf8').toString('base64url'),
          IDENTITY
        )
      ).toThrow(MobileTimelineCursorInvalidError)

      // The canonical no-row-consumed sentinel is head + 1 and is accepted; one
      // past it is not, and neither is a position below the current frontier.
      expect(() =>
        fx.projector.decodeAndValidateCursor(
          rewriteCursor(cursor, (value) => {
            value['beforeHrcSeq'] = 5
          }),
          IDENTITY
        )
      ).not.toThrow()
      expect(() =>
        fx.projector.decodeAndValidateCursor(
          rewriteCursor(cursor, (value) => {
            value['beforeHrcSeq'] = 6
          }),
          IDENTITY
        )
      ).toThrow(MobileTimelineCursorInvalidError)
      expect(() =>
        fx.projector.decodeAndValidateCursor(
          rewriteCursor(cursor, (value) => {
            value['beforeHrcSeq'] = 2
          }),
          IDENTITY
        )
      ).toThrow(MobileTimelineCursorInvalidError)
      expect(() =>
        fx.projector.decodeAndValidateCursor(
          rewriteCursor(cursor, (value) => {
            value['originTimelineOrdinal'] = '-1'
          }),
          IDENTITY
        )
      ).toThrow(MobileTimelineCursorInvalidError)
    } finally {
      fx.state.close()
    }
  })

  test('fails explicitly when a captured head leaves no representable frontier', async () => {
    const fx = fixture()
    try {
      fx.messages.push(
        message(Number.MAX_SAFE_INTEGER, 'ledger ceiling', '2026-08-30T00:00:01.000Z')
      )
      fx.events.push(event(1, 'A1', '2026-08-30T01:00:01.000Z'))

      await expect(fx.projector.open(IDENTITY, { target: 1 })).rejects.toBeInstanceOf(
        MobileTimelineSourcePositionExhaustedError
      )
      expect(fx.state.mobileTimeline.getActive(IDENTITY)).toBeUndefined()
    } finally {
      fx.state.close()
    }
  })

  // ── T-07718 contract, unchanged ────────────────────────────────────────────

  test('commits complete bounded catch-up but resets all-or-nothing when one more atom remains', async () => {
    const fx = fixture()
    try {
      fx.events.push(
        event(1, 'one', '2026-08-30T01:00:01.000Z'),
        event(2, 'two', '2026-08-30T01:00:02.000Z')
      )
      const first = await fx.projector.open(IDENTITY, { maxAtoms: 2, target: 1 })
      fx.events.push(
        event(3, 'three', '2026-08-30T01:00:03.000Z'),
        event(4, 'four', '2026-08-30T01:00:04.000Z')
      )
      const caughtUp = await fx.projector.open(IDENTITY, { maxAtoms: 2 })
      expect(caughtUp.projectionEpoch).toBe(first.projectionEpoch)
      expect(caughtUp.atoms.map((item) => item.sourceSeq)).toEqual([2, 3, 4])

      fx.events.push(
        event(5, 'five', '2026-08-30T01:00:05.000Z'),
        event(6, 'six', '2026-08-30T01:00:06.000Z'),
        event(7, 'seven', '2026-08-30T01:00:07.000Z')
      )
      const reset = await fx.projector.open(IDENTITY, { maxAtoms: 2 })
      expect(reset.projectionEpoch).not.toBe(first.projectionEpoch)
      expect(reset.resetReason).toBe('catch_up_limit_exceeded')
      expect(reset.atoms.map((item) => item.sourceSeq)).toEqual([6, 7])
      expect(() => fx.projector.decodeAndValidateCursor(first.olderCursor!, IDENTITY)).toThrow(
        MobileTimelineCursorInvalidError
      )
    } finally {
      fx.state.close()
    }
  })

  test('replays the same older cursor idempotently and invalidates either producer replacement', async () => {
    const fx = fixture()
    try {
      for (let seq = 1; seq <= 5; seq += 1) {
        fx.events.push(event(seq, String(seq), `2026-08-30T01:00:0${seq}.000Z`))
      }
      const opened = await fx.projector.open(IDENTITY, { target: 2 })
      const first = await fx.projector.page(IDENTITY, opened.olderCursor!, { target: 2 })
      const replay = await fx.projector.page(IDENTITY, opened.olderCursor!, { target: 2 })
      expect(replay).toEqual(first)
      expect(first.atoms.map((item) => item.sourceSeq)).toEqual([2, 3])

      fx.replaceWrkq()
      const wrkqReset = await fx.projector.open(IDENTITY, { target: 2 })
      await expect(
        fx.projector.page(IDENTITY, first.olderCursor!, { target: 2 })
      ).rejects.toBeInstanceOf(MobileTimelineCursorInvalidError)

      fx.replaceHrc()
      await fx.projector.open(IDENTITY, { target: 2 })
      await expect(
        fx.projector.page(IDENTITY, wrkqReset.olderCursor!, { target: 2 })
      ).rejects.toBeInstanceOf(MobileTimelineCursorInvalidError)
    } finally {
      fx.state.close()
    }
  })

  test('rejects malformed, wrong-type, wrong-identity, and future cursor positions', async () => {
    const fx = fixture()
    try {
      fx.events.push(
        event(1, 'one', '2026-08-30T01:00:01.000Z'),
        event(2, 'two', '2026-08-30T01:00:02.000Z')
      )
      const opened = await fx.projector.open(IDENTITY, { target: 1 })
      const cursor = opened.olderCursor!

      expect(() => fx.projector.decodeAndValidateCursor('not+base64', IDENTITY)).toThrow(
        MobileTimelineMalformedCursorError
      )
      expect(() =>
        fx.projector.decodeAndValidateCursor(
          rewriteCursor(cursor, (value) => {
            value['type'] = 'live_replay'
          }),
          IDENTITY
        )
      ).toThrow(MobileTimelineCursorInvalidError)
      expect(() =>
        fx.projector.decodeAndValidateCursor(cursor, { ...IDENTITY, generation: 5 })
      ).toThrow(MobileTimelineCursorInvalidError)
      expect(() =>
        fx.projector.decodeAndValidateCursor(
          rewriteCursor(cursor, (value) => {
            value['beforeHrcSeq'] = 99
          }),
          IDENTITY
        )
      ).toThrow(MobileTimelineCursorInvalidError)
      expect(() =>
        fx.projector.decodeAndValidateCursor(
          rewriteCursor(cursor, (value) => {
            value['beforeTimelineOrdinal'] = '1000000'
          }),
          IDENTITY
        )
      ).toThrow(MobileTimelineCursorInvalidError)
    } finally {
      fx.state.close()
    }
  })

  test('uses byte-gated all-or-nothing reset and fails one oversize atom without advancing', async () => {
    const fx = fixture()
    try {
      fx.events.push(event(1, 'seed', '2026-08-30T01:00:01.000Z'))
      const first = await fx.projector.open(IDENTITY, { target: 1, maxBytes: 2_000 })
      fx.events.push(
        event(2, 'x'.repeat(350), '2026-08-30T01:00:02.000Z'),
        event(3, 'y'.repeat(350), '2026-08-30T01:00:03.000Z')
      )
      // The closed-cohort ceiling now charges staged raw rows as well as
      // projected atoms, matching the catch-up path it is compared against.
      const reset = await fx.projector.open(IDENTITY, { target: 1, maxBytes: 1_500 })
      expect(reset.projectionEpoch).not.toBe(first.projectionEpoch)
      expect(reset.resetReason).toBe('catch_up_limit_exceeded')
      expect(reset.atoms.map((atom) => atom.sourceSeq)).toEqual([3])
    } finally {
      fx.state.close()
    }

    const oversize = fixture()
    try {
      oversize.events.push(event(1, 'z'.repeat(2_000), '2026-08-30T01:00:01.000Z'))
      await expect(
        oversize.projector.open(IDENTITY, { target: 1, maxBytes: 500 })
      ).rejects.toBeInstanceOf(MobileTimelineItemOversizeError)
      expect(oversize.state.mobileTimeline.getActive(IDENTITY)).toBeUndefined()
    } finally {
      oversize.state.close()
    }
  })

  test('drains wrkq catch-up beyond 500 exactly once and ignores regressing live timestamps', async () => {
    const fx = fixture()
    try {
      fx.messages.push(message(1, 'seed', '2026-08-30T01:00:01.000Z'))
      const first = await fx.projector.open(IDENTITY, { target: 1, maxAtoms: 1_000 })
      for (let seq = 2; seq <= 502; seq += 1) {
        fx.messages.push(message(seq, `message-${seq}`, '2026-08-30T01:00:02.000Z'))
      }
      const caughtUp = await fx.projector.open(IDENTITY, { target: 100, maxAtoms: 1_000 })
      expect(caughtUp.projectionEpoch).toBe(first.projectionEpoch)
      expect(fx.state.mobileTimeline.getActive(IDENTITY)?.messageNewestSeq).toBe(502)
      expect(fx.state.mobileTimeline.listNewest(first.projectionEpoch, 1_000)).toHaveLength(502)

      const replay = await fx.projector.open(IDENTITY, { target: 100, maxAtoms: 1_000 })
      expect(fx.state.mobileTimeline.listNewest(first.projectionEpoch, 1_000)).toHaveLength(502)
      expect(replay.atoms).toEqual(caughtUp.atoms)

      const admitted = await fx.projector.admitLiveHrc(
        IDENTITY,
        event(503, 'clock regressed', '2020-01-01T00:00:00.000Z')
      )
      expect(admitted[0]?.timelineOrdinal).toBe('502')
    } finally {
      fx.state.close()
    }
  })

  test('retires an epoch with an internal ordinal gap instead of mixing around it', async () => {
    const fx = fixture()
    try {
      fx.events.push(
        event(1, 'one', '2026-08-30T01:00:01.000Z'),
        event(2, 'two', '2026-08-30T01:00:02.000Z'),
        event(3, 'three', '2026-08-30T01:00:03.000Z')
      )
      const first = await fx.projector.open(IDENTITY, { target: 3 })
      fx.state.sqlite
        .prepare(
          'DELETE FROM mobile_timeline_atoms WHERE projection_epoch = ? AND timeline_ordinal = 1'
        )
        .run(first.projectionEpoch)

      const reset = await fx.projector.open(IDENTITY, { target: 3 })
      expect(reset.projectionEpoch).not.toBe(first.projectionEpoch)
      expect(reset.resetReason).toBe('projection_corrupt')
      expect(reset.atoms.map((item) => item.timelineOrdinal)).toEqual(['0', '1', '2'])
      const retired = fx.state.sqlite
        .prepare('SELECT active FROM mobile_timeline_projection_epochs WHERE projection_epoch = ?')
        .get(first.projectionEpoch) as { active: number }
      expect(retired.active).toBe(0)
    } finally {
      fx.state.close()
    }
  })
})
