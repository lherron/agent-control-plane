import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Database } from 'bun:sqlite'

import {
  MOBILE_TIMELINE_PROJECTION_CONTRACT_VERSION,
  MobileTimelineOrdinalExhaustedError,
  MobileTimelineProjectionCorruptError,
  openAcpStateStore,
} from '../src/index.js'

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
        hrcBeforeSeq: 10,
        hrcNewestSeq: 12,
        messageBeforeSeq: 0,
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
        hrcBeforeSeq: 20,
        hrcNewestSeq: 20,
        messageBeforeSeq: 0,
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
        hrcBeforeSeq: 10,
        hrcNewestSeq: 10,
        messageBeforeSeq: 0,
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
        hrcBeforeSeq: 8,
        messageBeforeSeq: 0,
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
        hrcBeforeSeq: 10,
        hrcNewestSeq: 10,
        messageBeforeSeq: 0,
        messageNewestSeq: 0,
        hrcExhaustedBefore: true,
        wrkqExhaustedBefore: true,
        originTimelineOrdinal: '9223372036854775807',
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

  test('restores the exact epoch and ordinals after a store restart', () => {
    const supportDir = mkdtempSync(join(tmpdir(), 't07718-projection-restart-'))
    const dbPath = join(supportDir, 'state.db')
    try {
      const firstStore = openAcpStateStore({ dbPath })
      const first = firstStore.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-a',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcBeforeSeq: 10,
        hrcNewestSeq: 11,
        messageBeforeSeq: 0,
        messageNewestSeq: 0,
        hrcExhaustedBefore: true,
        wrkqExhaustedBefore: true,
        atoms: [atom('hrc:hrc-a:10', 10), atom('hrc:hrc-a:11', 11)],
      })
      firstStore.close()

      const reopened = openAcpStateStore({ dbPath })
      try {
        expect(reopened.mobileTimeline.getActive(IDENTITY)?.projectionEpoch).toBe(
          first.projection.projectionEpoch
        )
        expect(
          reopened.mobileTimeline
            .listNewest(first.projection.projectionEpoch, 10)
            .map((item) => [item.atomId, item.timelineOrdinal])
        ).toEqual([
          ['hrc:hrc-a:10', '0'],
          ['hrc:hrc-a:11', '1'],
        ])
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(supportDir, { recursive: true, force: true })
    }
  })

  test('fails explicitly when durable atom ordinals contain an internal gap', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const first = store.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-a',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcBeforeSeq: 10,
        hrcNewestSeq: 12,
        messageBeforeSeq: 0,
        messageNewestSeq: 0,
        hrcExhaustedBefore: true,
        wrkqExhaustedBefore: true,
        atoms: [atom('hrc:hrc-a:10', 10), atom('hrc:hrc-a:11', 11), atom('hrc:hrc-a:12', 12)],
      })
      store.sqlite
        .prepare(
          'DELETE FROM mobile_timeline_atoms WHERE projection_epoch = ? AND timeline_ordinal = 1'
        )
        .run(first.projection.projectionEpoch)

      expect(() => store.mobileTimeline.getActive(IDENTITY)).toThrow(
        MobileTimelineProjectionCorruptError
      )
    } finally {
      store.close()
    }
  })

  test('anchors a zero-atom epoch on its origin and prepends below it', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const empty = store.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-a',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcBeforeSeq: 13,
        hrcNewestSeq: 12,
        messageBeforeSeq: 1,
        messageNewestSeq: 0,
        hrcExhaustedBefore: false,
        wrkqExhaustedBefore: true,
        atoms: [],
      })
      expect(empty.projection.originTimelineOrdinal).toBe('0')
      expect(empty.projection.minTimelineOrdinal).toBeNull()
      expect(empty.projection.maxTimelineOrdinal).toBeNull()
      expect(empty.projection.contractVersion).toBe(MOBILE_TIMELINE_PROJECTION_CONTRACT_VERSION)

      const epoch = empty.projection.projectionEpoch
      store.mobileTimeline.prependAtoms({
        projectionEpoch: epoch,
        atoms: [atom('hrc:hrc-a:11', 11), atom('hrc:hrc-a:12', 12)],
        hrcBeforeSeq: 11,
        messageBeforeSeq: 1,
        hrcExhaustedBefore: false,
        wrkqExhaustedBefore: true,
      })
      expect(
        store.mobileTimeline.listBefore(epoch, '0', 10).map((item) => item.timelineOrdinal)
      ).toEqual(['-2', '-1'])

      // Live admission after an origin-anchored prepend still appends above the
      // origin rather than colliding with the negative range.
      store.mobileTimeline.appendAtoms({
        projectionEpoch: epoch,
        atoms: [atom('hrc:hrc-a:13', 13)],
        hrcNewestSeq: 13,
        messageNewestSeq: 0,
      })
      expect(
        store.mobileTimeline.listNewest(epoch, 10).map((item) => item.timelineOrdinal)
      ).toEqual(['-2', '-1', '0'])
      const after = store.mobileTimeline.getActive(IDENTITY)
      expect([after?.hrcBeforeSeq, after?.hrcNewestSeq]).toEqual([11, 13])
    } finally {
      store.close()
    }
  })

  test('keys page receipts by cursor digest and limit, and retires them with the epoch', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const first = store.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-a',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcBeforeSeq: 10,
        hrcNewestSeq: 11,
        messageBeforeSeq: 1,
        messageNewestSeq: 0,
        hrcExhaustedBefore: false,
        wrkqExhaustedBefore: true,
        atoms: [atom('hrc:hrc-a:10', 10), atom('hrc:hrc-a:11', 11)],
      })
      const epoch = first.projection.projectionEpoch
      const base = {
        projectionEpoch: epoch,
        requestDigest: 'digest-a',
        responseContractVersion: 2,
        boundaryTimelineOrdinal: '2',
        olderCursor: 'cursor-a',
        hasMoreBefore: true,
        highWaterHrcSeq: 11,
        highWaterMessageSeq: 0,
        resetReason: null,
      }
      store.mobileTimeline.putPageReceipt({
        ...base,
        requestedLimit: 2,
        atomIds: ['hrc:hrc-a:10', 'hrc:hrc-a:11'],
        timelineOrdinals: ['0', '1'],
      })
      store.mobileTimeline.putPageReceipt({
        ...base,
        requestedLimit: 1,
        atomIds: ['hrc:hrc-a:11'],
        timelineOrdinals: ['1'],
      })

      // One cursor, two limits, two receipts: neither can satisfy the other.
      expect(
        store.mobileTimeline.getPageReceipt({
          projectionEpoch: epoch,
          requestDigest: 'digest-a',
          requestedLimit: 2,
          responseContractVersion: 2,
        })?.atomIds
      ).toEqual(['hrc:hrc-a:10', 'hrc:hrc-a:11'])
      expect(
        store.mobileTimeline.getPageReceipt({
          projectionEpoch: epoch,
          requestDigest: 'digest-a',
          requestedLimit: 1,
          responseContractVersion: 2,
        })?.atomIds
      ).toEqual(['hrc:hrc-a:11'])
      expect(
        store.mobileTimeline.getPageReceipt({
          projectionEpoch: epoch,
          requestDigest: 'digest-a',
          requestedLimit: 1,
          responseContractVersion: 3,
        })
      ).toBeUndefined()

      // A first writer wins: a second put for the same identity never rewrites.
      const rewritten = store.mobileTimeline.putPageReceipt({
        ...base,
        requestedLimit: 1,
        atomIds: ['hrc:hrc-a:10'],
        timelineOrdinals: ['0'],
      })
      expect(rewritten.atomIds).toEqual(['hrc:hrc-a:11'])

      expect(() =>
        store.mobileTimeline.putPageReceipt({
          ...base,
          requestDigest: 'digest-b',
          requestedLimit: 1,
          atomIds: ['hrc:hrc-a:10', 'hrc:hrc-a:11'],
          timelineOrdinals: ['0', '1'],
        })
      ).toThrow(MobileTimelineProjectionCorruptError)

      expect(
        store.mobileTimeline
          .listByAtomIds(epoch, ['hrc:hrc-a:11', 'hrc:hrc-a:10'])
          .map((item) => item.atomId)
      ).toEqual(['hrc:hrc-a:11', 'hrc:hrc-a:10'])

      store.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-b',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcBeforeSeq: 20,
        hrcNewestSeq: 20,
        messageBeforeSeq: 1,
        messageNewestSeq: 0,
        hrcExhaustedBefore: true,
        wrkqExhaustedBefore: true,
        resetReason: 'producer_incarnation_changed',
        atoms: [atom('hrc:hrc-b:20', 20)],
      })
      expect(
        store.mobileTimeline.getPageReceipt({
          projectionEpoch: epoch,
          requestDigest: 'digest-a',
          requestedLimit: 2,
          responseContractVersion: 2,
        })
      ).toBeUndefined()
    } finally {
      store.close()
    }
  })

  test('retires v1 projections instead of reinterpreting their oldest-seq columns', () => {
    const supportDir = mkdtempSync(join(tmpdir(), 't07728-v1-retirement-'))
    const dbPath = join(supportDir, 'state.db')
    try {
      const legacy = new Database(dbPath)
      legacy.exec(`
        CREATE TABLE mobile_timeline_projection_epochs (
          projection_epoch TEXT PRIMARY KEY,
          session_ref TEXT NOT NULL,
          host_session_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          hrc_ledger_incarnation_id TEXT NOT NULL,
          wrkq_ledger_incarnation_id TEXT NOT NULL,
          hrc_oldest_seq INTEGER NOT NULL,
          hrc_newest_seq INTEGER NOT NULL,
          message_oldest_seq INTEGER NOT NULL,
          message_newest_seq INTEGER NOT NULL,
          hrc_exhausted_before INTEGER NOT NULL CHECK (hrc_exhausted_before IN (0, 1)),
          wrkq_exhausted_before INTEGER NOT NULL CHECK (wrkq_exhausted_before IN (0, 1)),
          min_timeline_ordinal INTEGER,
          max_timeline_ordinal INTEGER,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          reset_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO mobile_timeline_projection_epochs VALUES (
          'tlp_v1', '${IDENTITY.sessionRef}', '${IDENTITY.hostSessionId}', ${IDENTITY.generation},
          'hrc-a', 'wrkq-a', 10, 12, 0, 0, 0, 1, NULL, NULL, 1, NULL,
          '2026-08-29T00:00:00.000Z', '2026-08-29T00:00:00.000Z'
        );
      `)
      legacy.close()

      const store = openAcpStateStore({ dbPath })
      try {
        expect(store.mobileTimeline.getActive(IDENTITY)).toBeUndefined()
        const retired = store.mobileTimeline.getEpoch('tlp_v1')
        expect(retired?.active).toBe(false)
        expect(retired?.contractVersion).toBe(1)
        const columns = store.sqlite
          .prepare('PRAGMA table_info(mobile_timeline_projection_epochs)')
          .all() as Array<{ name: string }>
        expect(columns.map((column) => column.name)).not.toContain('hrc_oldest_seq')
        expect(columns.map((column) => column.name)).toContain('hrc_before_seq')
      } finally {
        store.close()
      }
    } finally {
      rmSync(supportDir, { recursive: true, force: true })
    }
  })

  test('pages timeline ordinals numerically after crossing the first digit', () => {
    const store = openAcpStateStore({ dbPath: ':memory:' })
    try {
      const first = store.mobileTimeline.replaceEpoch({
        identity: IDENTITY,
        hrcLedgerIncarnationId: 'hrc-a',
        wrkqLedgerIncarnationId: 'wrkq-a',
        hrcBeforeSeq: 1,
        hrcNewestSeq: 12,
        messageBeforeSeq: 0,
        messageNewestSeq: 0,
        hrcExhaustedBefore: true,
        wrkqExhaustedBefore: true,
        atoms: Array.from({ length: 12 }, (_, index) => atom(`hrc:hrc-a:${index + 1}`, index + 1)),
      })

      expect(
        store.mobileTimeline
          .listNewest(first.projection.projectionEpoch, 5)
          .map((item) => item.timelineOrdinal)
      ).toEqual(['7', '8', '9', '10', '11'])
      expect(
        store.mobileTimeline
          .listBefore(first.projection.projectionEpoch, '12', 3)
          .map((item) => item.timelineOrdinal)
      ).toEqual(['9', '10', '11'])
    } finally {
      store.close()
    }
  })
})
