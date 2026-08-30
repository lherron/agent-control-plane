import { describe, expect, test } from 'bun:test'
import { openAcpStateStore } from 'acp-state-store'
import type { HrcEventTail, HrcLifecycleEvent } from 'hrc-core'
import type { CollaborationMessage, CollaborationMessagePage } from 'wrkq-lib'

import {
  MobileTimelineCursorInvalidError,
  MobileTimelineItemOversizeError,
  MobileTimelineMalformedCursorError,
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
  let hrcIncarnation = 'hrc-a'
  let wrkqIncarnation = 'wrkq-a'
  const state = openAcpStateStore({ dbPath: ':memory:' })
  const projector = createMobileTimelineProjector({
    store: state.mobileTimeline,
    hrcClient: {
      async tailEvents(options): Promise<HrcEventTail> {
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
    state,
    replaceHrc: () => {
      hrcIncarnation = 'hrc-b'
    },
    replaceWrkq: () => {
      wrkqIncarnation = 'wrkq-b'
    },
  }
}

function rewriteCursor(token: string, change: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >
  change(value)
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
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
      const reset = await fx.projector.open(IDENTITY, { target: 1, maxBytes: 1_000 })
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
})
