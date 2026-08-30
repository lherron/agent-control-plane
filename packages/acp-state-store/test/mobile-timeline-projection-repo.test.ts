import { describe, expect, test } from 'bun:test'

import { MobileTimelineOrdinalExhaustedError, openAcpStateStore } from '../src/index.js'

const IDENTITY = {
  sessionRef: 'agent:cody:project:agent-control-plane:task:T-07718/lane:main',
  hostSessionId: 'hsid-t07718',
  generation: 3,
}

function atom(atomId: string, sourceSeq: number, logicalFrameId = atomId) {
  return {
    atomId,
    logicalFrameId,
    operation: 'append' as const,
    sourceKind: 'hrc' as const,
    sourceSeq,
    sourceTs: `2026-08-30T01:00:${String(sourceSeq).padStart(2, '0')}.000Z`,
    payload: { blocks: [{ kind: 'markdown', text: atomId }] },
    prefixState: 'unknown' as const,
  }
}

describe('mobile timeline projection repo', () => {
  test('replaces epochs atomically and never mutates an admitted source identity ordinal', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const first = store.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-a',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcOldestSeq: 10,
        hrcNewestSeq: 12,
        messageOldestSeq: 0,
        messageNewestSeq: 0,
        hrcExhaustedBefore: false,
        wrkqExhaustedBefore: true,
        atoms: [atom('hrc:hrc-a:10', 10, 'assistant'), atom('hrc:hrc-a:12', 12, 'assistant')],
      })

      expect(first.atoms.map((item) => [item.atomId, item.timelineOrdinal])).toEqual([
        ['hrc:hrc-a:10', '0'],
        ['hrc:hrc-a:12', '1'],
      ])

      const replay = store.mobileTimeline.appendAtoms({
        projectionEpoch: first.projection.projectionEpoch,
        atoms: [atom('hrc:hrc-a:12', 12, 'assistant')],
        hrcNewestSeq: 12,
        messageNewestSeq: 0,
      })
      expect(replay.inserted).toEqual([])
      expect(
        store.mobileTimeline
          .listNewest(first.projection.projectionEpoch, 10)
          .map((item) => item.timelineOrdinal)
      ).toEqual(['0', '1'])

      const replacement = store.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-b',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcOldestSeq: 20,
        hrcNewestSeq: 20,
        messageOldestSeq: 0,
        messageNewestSeq: 0,
        hrcExhaustedBefore: true,
        wrkqExhaustedBefore: true,
        resetReason: 'producer_incarnation_changed',
        atoms: [atom('hrc:hrc-b:20', 20)],
      })

      expect(replacement.projection.projectionEpoch).not.toBe(first.projection.projectionEpoch)
      expect(store.mobileTimeline.getEpoch(first.projection.projectionEpoch)?.active).toBe(false)
      expect(store.mobileTimeline.getActive(IDENTITY)?.projectionEpoch).toBe(
        replacement.projection.projectionEpoch
      )
    } finally {
      store.close()
    }
  })

  test('prepends closed cohorts below min and appends live atoms above max without timestamp reorder', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const first = store.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-a',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcOldestSeq: 10,
        hrcNewestSeq: 10,
        messageOldestSeq: 0,
        messageNewestSeq: 0,
        hrcExhaustedBefore: false,
        wrkqExhaustedBefore: true,
        atoms: [atom('hrc:hrc-a:10', 10)],
      })
      const epoch = first.projection.projectionEpoch

      const live = atom('hrc:hrc-a:11', 11)
      live.sourceTs = '1970-01-01T00:00:00.000Z'
      store.mobileTimeline.appendAtoms({
        projectionEpoch: epoch,
        atoms: [live],
        hrcNewestSeq: 11,
        messageNewestSeq: 0,
      })
      store.mobileTimeline.prependAtoms({
        projectionEpoch: epoch,
        atoms: [atom('hrc:hrc-a:8', 8), atom('hrc:hrc-a:9', 9)],
        hrcOldestSeq: 8,
        messageOldestSeq: 0,
        hrcExhaustedBefore: true,
        wrkqExhaustedBefore: true,
      })

      expect(
        store.mobileTimeline
          .listNewest(epoch, 10)
          .map((item) => [item.atomId, item.timelineOrdinal])
      ).toEqual([
        ['hrc:hrc-a:8', '-2'],
        ['hrc:hrc-a:9', '-1'],
        ['hrc:hrc-a:10', '0'],
        ['hrc:hrc-a:11', '1'],
      ])
    } finally {
      store.close()
    }
  })

  test('fails explicitly instead of wrapping a signed 64-bit ordinal', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const first = store.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-a',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcOldestSeq: 10,
        hrcNewestSeq: 10,
        messageOldestSeq: 0,
        messageNewestSeq: 0,
        hrcExhaustedBefore: true,
        wrkqExhaustedBefore: true,
        initialOrdinal: '9223372036854775807',
        atoms: [atom('hrc:hrc-a:10', 10)],
      })

      expect(() =>
        store.mobileTimeline.appendAtoms({
          projectionEpoch: first.projection.projectionEpoch,
          atoms: [atom('hrc:hrc-a:11', 11)],
          hrcNewestSeq: 11,
          messageNewestSeq: 0,
        })
      ).toThrow(MobileTimelineOrdinalExhaustedError)
    } finally {
      store.close()
    }
  })
})
