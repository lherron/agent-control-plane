import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  cleanupFixtureDirs,
  createEvidenceHrcDb,
  createHrcDb,
  createTmuxActuationFixture,
  insertAssistantMessage,
  insertCompletedPair,
  insertEvidenceEvent,
  insertSessionEvent,
  isoAgo,
  makeRun,
} from '../../test/fixtures/interface-run-dispatcher.js'
import { readCompletedAssistantMessageAfterSeq } from '../launcher-assistant-evidence.js'
import { lastObservedActivityMs } from './interface-run-dispatcher.js'
import * as dispatcherModule from './interface-run-dispatcher.js'

afterEach(cleanupFixtureDirs)

describe('interface run dispatcher schema transitions and read transactions', () => {
  test('T-TX3 dispatcher finalize detects and selects from one production read transaction', async () => {
    const hrc = createHrcDb()
    hrc.db.exec('PRAGMA journal_mode = WAL')
    // A 10-minute stale window keeps a loaded runner from timing the run out
    // between the two reads (CI run 41280761236 took 65ms against the 10ms
    // default); staleness is not what this test fences (T-12143 pattern).
    const fx = createTmuxActuationFixture({
      hrcDbPath: hrc.hrcDbPath,
      generation: 7,
      staleTimeoutMs: 10 * 60_000,
    })
    insertAssistantMessage(hrc.db, {
      hrcSeq: 5,
      hostSessionId: 'hsid-retained',
      scopeRef: fx.sessionRef.scopeRef,
      laneRef: fx.sessionRef.laneRef,
      generation: 7,
      runId: 'run-live',
      text: 'LIVE-BASELINE',
    })
    const writer = new Database(hrc.hrcDbPath)
    writer.exec('PRAGMA journal_mode = WAL')
    const detectionPatch = patchSchemaDetection(() => {
      writer.exec(
        "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
      )
      insertCompletedPair(writer, {
        firstSeq: 11,
        text: 'OLD-REPLY',
        runId: 'run-hist',
        evidenceOrigin: 'retained',
      })
    })

    try {
      await fx.dispatcher.runOnce()
      expect(detectionPatch.injected()).toBe(true)
      expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')
      expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toHaveLength(0)

      await fx.dispatcher.runOnce()
      expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')
      expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toHaveLength(0)
    } finally {
      detectionPatch.restore()
      writer.close()
      fx.interfaceStore.close()
      hrc.db.close()
    }
  })

  test('T-TX4 activity read detects and selects from one production read transaction', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    hrc.db.exec('PRAGMA journal_mode = WAL')
    const run = makeRun({
      updatedAt: isoAgo(now, 20_000),
      hostSessionId: 'hsid-retained',
      generation: 7,
      afterHrcSeq: 10,
    })
    insertSessionEvent(hrc.db, {
      hrcSeq: 11,
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: { tool: 'live' },
    })
    const writer = new Database(hrc.hrcDbPath)
    writer.exec('PRAGMA journal_mode = WAL')
    const detectionPatch = patchSchemaDetection(() => {
      writer.exec(
        "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
      )
      insertEvidenceEvent(writer, {
        hrcSeq: 12,
        ts: isoAgo(now, 2 * 60 * 60_000),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: 7,
        runId: 'run-hist',
        eventKind: 'turn.tool_call',
        payload: { tool: 'retained' },
        evidenceOrigin: 'retained',
      })
    })

    try {
      const observed = lastObservedActivityMs(run, hrc.hrcDbPath)
      expect(detectionPatch.injected()).toBe(true)
      expect(observed).toBeGreaterThanOrEqual(now - 1_000)

      expect(lastObservedActivityMs(run, hrc.hrcDbPath)).toBeGreaterThanOrEqual(now - 1_000)
    } finally {
      detectionPatch.restore()
      writer.close()
      hrc.db.close()
    }
  })

  test('U-up observes old-to-new schema upgrade without recreating the dispatcher', async () => {
    const hrc = createHrcDb()
    // This tests live schema detection, not a 10 ms stale deadline between reads.
    const fx = createTmuxActuationFixture({
      hrcDbPath: hrc.hrcDbPath,
      generation: 7,
      staleTimeoutMs: 10 * 60_000,
    })
    await fx.dispatcher.runOnce()
    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')

    hrc.db.exec(
      "ALTER TABLE hrc_events ADD COLUMN evidence_origin TEXT CHECK (evidence_origin IS NULL OR evidence_origin = 'retained')"
    )
    insertCompletedPair(hrc.db, {
      firstSeq: 11,
      text: 'OLD-REPLY',
      runId: 'run-hist',
      evidenceOrigin: 'retained',
    })
    await fx.dispatcher.runOnce()
    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')

    insertCompletedPair(hrc.db, {
      firstSeq: 13,
      text: 'NEW-REPLY',
      runId: 'run-live',
      evidenceOrigin: null,
    })
    await fx.dispatcher.runOnce()
    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('completed')
    expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toMatchObject([
      { bodyText: 'NEW-REPLY' },
    ])
    fx.interfaceStore.close()
    hrc.db.close()
  })

  test('U-err S3 missing hrc_events table makes the completed-message reader throw naming the table', () => {
    const hrc = createEvidenceHrcDb()
    hrc.db.exec('ALTER TABLE hrc_events RENAME TO hrc_events_removed')
    expect(() =>
      readCompletedAssistantMessageAfterSeq({
        hrcDbPath: hrc.hrcDbPath,
        hostSessionId: 'hsid-retained',
        sessionRef: {
          scopeRef: 'agent:smokey:project:agent-control-plane:task:T-08575',
          laneRef: 'main',
        },
        afterHrcSeq: 10,
      })
    ).toThrow('hrc_events schema unrecognized: table missing')
    hrc.db.close()
  })

  test.each([
    { age: 'fresh', staleTimeoutMs: 60_000, expected: 'running' },
    { age: 'aged', staleTimeoutMs: 10, expected: 'failed' },
  ])(
    'U-err S4 with hrc_events gone, a $age own run falls back to run.updatedAt for staleness',
    async ({ staleTimeoutMs, expected }) => {
      const hrc = createEvidenceHrcDb()
      const fx = createTmuxActuationFixture({
        hrcDbPath: hrc.hrcDbPath,
        generation: 7,
        hrcRunId: 'run-own',
      })
      hrc.db.exec('ALTER TABLE hrc_events RENAME TO hrc_events_removed')
      await Bun.sleep(20)
      const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
        runStore: fx.runStore,
        interfaceStore: fx.interfaceStore,
        hrcDbPath: hrc.hrcDbPath,
        config: { intervalMs: 1, staleTimeoutMs },
      })

      await dispatcher.runOnce()

      const run = fx.runStore.getRun(fx.run.runId)
      expect(run?.status).toBe(expected)
      if (expected === 'failed') expect(run?.errorCode).toBe('turn_timeout')
      fx.interfaceStore.close()
      hrc.db.close()
    }
  )
})

type SqlStatementFactory = (this: Database, sql: string) => object

function patchSchemaDetection(inject: () => void): {
  injected: () => boolean
  restore: () => void
} {
  const prototype = Database.prototype as unknown as {
    query: SqlStatementFactory
    prepare: SqlStatementFactory
  }
  const originalQuery = prototype.query
  const originalPrepare = prototype.prepare
  let didInject = false

  const wrapStatement = (statement: object, sql: string): object => {
    if (!/table_info/i.test(sql)) return statement
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (
          (property === 'all' || property === 'get' || property === 'values') &&
          typeof value === 'function'
        ) {
          return (...args: unknown[]) => {
            const result = Reflect.apply(value, target, args)
            if (!didInject) {
              inject()
              didInject = true
            }
            return result
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  prototype.query = function query(sql: string): object {
    return wrapStatement(originalQuery.call(this, sql), sql)
  }
  prototype.prepare = function prepare(sql: string): object {
    return wrapStatement(originalPrepare.call(this, sql), sql)
  }

  return {
    injected: () => didInject,
    restore: () => {
      prototype.query = originalQuery
      prototype.prepare = originalPrepare
    },
  }
}
