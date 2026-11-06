import { afterEach, describe, expect, test } from 'bun:test'
import { setSystemTime } from 'bun:test'
import {
  cleanupFixtureDirs,
  createEvidenceHrcDb,
  createHrcDb,
  createTmuxActuationFixture,
  insertEvidenceEvent,
  insertHrcEvent,
  isoAgo,
  makeRun,
} from '../../test/fixtures/interface-run-dispatcher.js'
import type { StoredRun } from '../domain/run-store.js'
import { lastObservedActivityMs } from './interface-run-dispatcher.js'
import * as dispatcherModule from './interface-run-dispatcher.js'

afterEach(cleanupFixtureDirs)

describe('interface run dispatcher stale activity window', () => {
  test.each([
    {
      name: 'recent correlated hrc_events activity keeps an aging own run running',
      hrcRunId: 'hrc-run-active',
      events: [
        { hrcSeq: 11, ageMs: 9 * 60_000, runId: 'hrc-run-active' },
        { hrcSeq: 12, ageMs: 0, runId: 'hrc-run-active' },
      ],
      expected: 'running',
    },
    {
      name: "only another run's fresh activity lets an aging own run time out",
      hrcRunId: 'hrc-run-missing',
      events: [{ hrcSeq: 11, ageMs: 0, runId: 'other-hrc-run' }],
      expected: 'failed',
    },
    {
      name: 'only old correlated activity lets an aging own run time out',
      hrcRunId: 'hrc-run-idle',
      events: [{ hrcSeq: 11, ageMs: 15 * 60_000, runId: 'hrc-run-idle' }],
      expected: 'failed',
    },
    {
      name: 'fresh session activity does not slide the dispatch timeout of a pending run without hrcRunId',
      status: 'pending' as const,
      events: [{ hrcSeq: 11, ageMs: 0, runId: 'hrc-run-not-yet-correlated' }],
      expected: 'failed',
      errorCode: 'dispatch_timeout',
    },
  ])('$name', async ({ hrcRunId, status, events, expected, errorCode }) => {
    const run = await runOnceAfterActivity({
      generation: 7,
      hrcRunId,
      status,
      events: events.map((event) => ({ ...event, evidenceOrigin: null })),
    })

    expect(run?.status).toBe(expected)
    if (expected === 'failed') expect(run?.errorCode).toBe(errorCode ?? 'turn_timeout')
  })

  test('clamps future hrc_events timestamps to now before stale math', () => {
    const now = Date.now()
    const hrc = createHrcDb()
    const run = makeRun({
      status: 'running',
      updatedAt: isoAgo(now, 12 * 60_000),
      hrcRunId: 'hrc-run-future',
      hostSessionId: 'hsid-future',
      generation: 9,
    })

    insertHrcEvent(hrc.db, {
      ts: new Date(now + 5 * 60_000).toISOString(),
      runId: run.hrcRunId,
      hostSessionId: run.hostSessionId,
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: run.generation,
    })

    const before = Date.now()
    const observed = lastObservedActivityMs(run, hrc.hrcDbPath)
    const after = Date.now()

    expect(observed).toBeGreaterThanOrEqual(before)
    expect(observed).toBeLessThanOrEqual(after)
    expect(after - observed > 600_000).toBe(false)
  })
  test.each([
    {
      name: 'T4 C ordinary old activity at the higher seq makes the run stale (without generation)',
      generation: undefined,
      hrcRunId: undefined,
      oldOrigin: null,
      expected: 'failed',
    },
    {
      name: 'T4 C ordinary old activity at the higher seq makes the run stale (with generation)',
      generation: 7,
      hrcRunId: undefined,
      oldOrigin: null,
      expected: 'failed',
    },
    {
      name: 'T4b retained old activity is fenced on the own-hrcRunId activity branch',
      generation: 7,
      hrcRunId: 'run-live',
      oldOrigin: 'retained',
      expected: 'running',
    },
    {
      name: 'T4b C ordinary old activity still makes the own-run branch stale',
      generation: 7,
      hrcRunId: 'run-live',
      oldOrigin: null,
      expected: 'failed',
    },
  ] as const)('$name', async ({ generation, hrcRunId, oldOrigin, expected }) => {
    const run = await runOnceAfterActivity({
      generation,
      hrcRunId,
      events: [
        { hrcSeq: 11, ageMs: 0, runId: hrcRunId ?? 'run-11', evidenceOrigin: null },
        {
          hrcSeq: 12,
          ageMs: 2 * 60 * 60_000,
          runId: hrcRunId ?? 'run-12',
          evidenceOrigin: oldOrigin,
        },
      ],
    })

    expect(run?.status).toBe(expected)
    if (expected === 'failed') expect(run?.errorCode).toBe('turn_timeout')
  })

  for (const generation of [undefined, 7] as const) {
    test(`T4 runOnce does not emit turn_timeout from retained old activity (${generation === undefined ? 'without' : 'with'} generation)`, async () => {
      const hrc = createEvidenceHrcDb()
      // Birth the run past the stale window so only fresh activity can keep it running;
      // the 10-minute window leaves no wall-clock race between insert and runOnce.
      const fx = createTmuxActuationFixture({
        hrcDbPath: hrc.hrcDbPath,
        generation,
        bornAgoMs: 12 * 60_000,
        staleTimeoutMs: 10 * 60_000,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 11,
        hostSessionId: 'hsid-retained',
        scopeRef: fx.sessionRef.scopeRef,
        laneRef: fx.sessionRef.laneRef,
        generation: generation ?? 0,
        runId: 'run-live',
        eventKind: 'turn.tool_call',
        payload: {},
        evidenceOrigin: null,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 12,
        ts: isoAgo(Date.now(), 2 * 60 * 60_000),
        hostSessionId: 'hsid-retained',
        scopeRef: fx.sessionRef.scopeRef,
        laneRef: fx.sessionRef.laneRef,
        generation: generation ?? 0,
        runId: 'run-hist',
        eventKind: 'turn.tool_call',
        payload: {},
        evidenceOrigin: 'retained',
      })

      await fx.dispatcher.runOnce()

      expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')
      expect(fx.runStore.getRun(fx.run.runId)?.errorCode).not.toBe('turn_timeout')
      fx.interfaceStore.close()
      hrc.db.close()
    })
  }

  for (const branch of ['without-generation', 'with-generation', 'own-run'] as const) {
    for (const control of [
      { id: 'retained', origin: 'retained' as const, expectedStatus: 'failed' },
      { id: 'C', origin: null, expectedStatus: 'running' },
    ]) {
      test(`T4c runOnce ${control.id} fresh activity (${branch})`, async () => {
        const hrc = createEvidenceHrcDb()
        const fx = createTmuxActuationFixture({
          hrcDbPath: hrc.hrcDbPath,
          generation: branch === 'without-generation' ? undefined : 7,
          hrcRunId: branch === 'own-run' ? 'run-live' : undefined,
          bornAgoMs: 12 * 60_000,
          staleTimeoutMs: 10 * 60_000,
        })
        insertEvidenceEvent(hrc.db, {
          hrcSeq: 11,
          hostSessionId: 'hsid-retained',
          scopeRef: fx.sessionRef.scopeRef,
          laneRef: fx.sessionRef.laneRef,
          generation: branch === 'without-generation' ? 0 : 7,
          runId: branch === 'own-run' ? 'run-live' : 'run-recovered',
          eventKind: 'runtime.interrupted',
          payload: {},
          evidenceOrigin: control.origin,
        })

        await fx.dispatcher.runOnce()

        expect(fx.runStore.getRun(fx.run.runId)?.status).toBe(control.expectedStatus)
        if (control.expectedStatus === 'failed') {
          expect(fx.runStore.getRun(fx.run.runId)?.errorCode).toBe('turn_timeout')
        }
        fx.interfaceStore.close()
        hrc.db.close()
      })
    }
  }
})

async function runOnceAfterActivity(input: {
  generation?: number | undefined
  hrcRunId?: string | undefined
  status?: 'pending' | undefined
  events: Array<{ hrcSeq: number; ageMs: number; runId: string; evidenceOrigin: EvidenceOrigin }>
}): Promise<StoredRun | undefined> {
  const hrc = createEvidenceHrcDb()
  // Birth the run 12 minutes ago so its updatedAt alone is past the 10-minute stale window.
  setSystemTime(new Date(Date.now() - 12 * 60_000))
  let fx: ReturnType<typeof createTmuxActuationFixture>
  try {
    fx = createTmuxActuationFixture({
      hrcDbPath: hrc.hrcDbPath,
      generation: input.generation,
      hrcRunId: input.hrcRunId,
    })
    if (input.status !== undefined) fx.runStore.updateRun(fx.run.runId, { status: input.status })
  } finally {
    setSystemTime()
  }
  const now = Date.now()
  for (const event of input.events) {
    insertEvidenceEvent(hrc.db, {
      hrcSeq: event.hrcSeq,
      ts: isoAgo(now, event.ageMs),
      hostSessionId: 'hsid-retained',
      scopeRef: fx.sessionRef.scopeRef,
      laneRef: fx.sessionRef.laneRef,
      generation: input.generation ?? 0,
      runId: event.runId,
      eventKind: 'turn.tool_call',
      payload: {},
      evidenceOrigin: event.evidenceOrigin,
    })
  }
  const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
    runStore: fx.runStore,
    interfaceStore: fx.interfaceStore,
    hrcDbPath: hrc.hrcDbPath,
    config: { intervalMs: 1, staleTimeoutMs: 600_000 },
  })
  try {
    await dispatcher.runOnce()
    return fx.runStore.getRun(fx.run.runId)
  } finally {
    fx.interfaceStore.close()
    hrc.db.close()
  }
}

function isStaleFromLastObservedActivity(
  run: StoredRun,
  hrcDbPath: string,
  staleTimeoutMs: number
): boolean {
  return Date.now() - lastObservedActivityMs(run, hrcDbPath) > staleTimeoutMs
}

describe('retained-evidence original incident boundaries', () => {
  for (const generation of [undefined, 7] as const) {
    test(`T4 retained old activity cannot regress live activity (${generation === undefined ? 'without' : 'with'} generation)`, async () => {
      const now = Date.now()
      const hrc = createEvidenceHrcDb()
      const run = makeRun({
        updatedAt: isoAgo(now, 20_000),
        hostSessionId: 'hsid-retained',
        generation,
        afterHrcSeq: 10,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 11,
        ts: new Date(now).toISOString(),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: generation ?? 0,
        runId: 'run-live',
        eventKind: 'turn.tool_call',
        payload: { tool: 'live' },
        evidenceOrigin: null,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 12,
        ts: isoAgo(now, 2 * 60 * 60_000),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: generation ?? 0,
        runId: 'run-hist',
        eventKind: 'turn.tool_call',
        payload: { tool: 'retained' },
        evidenceOrigin: 'retained',
      })

      expect(lastObservedActivityMs(run, hrc.hrcDbPath)).toBeGreaterThanOrEqual(now - 1_000)
      expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(false)
      hrc.db.close()
    })
    test(`T4 C ordinary old activity remains the latest actuator (${generation === undefined ? 'without' : 'with'} generation)`, () => {
      const now = Date.now()
      const hrc = createEvidenceHrcDb()
      const run = makeRun({
        updatedAt: isoAgo(now, 20_000),
        hostSessionId: 'hsid-retained',
        generation,
        afterHrcSeq: 10,
      })
      for (const [hrcSeq, ts] of [
        [11, new Date(now).toISOString()],
        [12, isoAgo(now, 2 * 60 * 60_000)],
      ] as const) {
        insertEvidenceEvent(hrc.db, {
          hrcSeq,
          ts,
          hostSessionId: 'hsid-retained',
          scopeRef: run.scopeRef,
          laneRef: run.laneRef,
          generation: generation ?? 0,
          runId: `run-${hrcSeq}`,
          eventKind: 'turn.tool_call',
          payload: {},
          evidenceOrigin: null,
        })
      }
      expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(true)
      hrc.db.close()
    })
  }
  test('T4b retained old activity is fenced on the own-hrcRunId activity branch', () => {
    const now = Date.now()
    const hrc = createEvidenceHrcDb()
    const run = makeRun({
      updatedAt: isoAgo(now, 20_000),
      hrcRunId: 'run-live',
      hostSessionId: 'hsid-retained',
      generation: 7,
    })
    insertEvidenceEvent(hrc.db, {
      hrcSeq: 11,
      ts: new Date(now).toISOString(),
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: {},
      evidenceOrigin: null,
    })
    insertEvidenceEvent(hrc.db, {
      hrcSeq: 12,
      ts: isoAgo(now, 2 * 60 * 60_000),
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: {},
      evidenceOrigin: 'retained',
    })
    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(false)
    hrc.db.close()
  })
  test('T4b C ordinary old activity still makes the own-run branch stale', () => {
    const now = Date.now()
    const hrc = createEvidenceHrcDb()
    const run = makeRun({
      updatedAt: isoAgo(now, 20_000),
      hrcRunId: 'run-live',
      hostSessionId: 'hsid-retained',
      generation: 7,
    })
    insertEvidenceEvent(hrc.db, {
      hrcSeq: 11,
      ts: new Date(now).toISOString(),
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: {},
      evidenceOrigin: null,
    })
    insertEvidenceEvent(hrc.db, {
      hrcSeq: 12,
      ts: isoAgo(now, 2 * 60 * 60_000),
      hostSessionId: 'hsid-retained',
      scopeRef: run.scopeRef,
      laneRef: run.laneRef,
      generation: 7,
      runId: 'run-live',
      eventKind: 'turn.tool_call',
      payload: {},
      evidenceOrigin: null,
    })
    expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(true)
    hrc.db.close()
  })
  for (const branch of ['without-generation', 'with-generation', 'own-run'] as const) {
    test(`T4c fresh retained audit activity cannot delay timeout (${branch})`, () => {
      const now = Date.now()
      const hrc = createEvidenceHrcDb()
      const run = makeRun({
        updatedAt: isoAgo(now, 20_000),
        hostSessionId: 'hsid-retained',
        generation: branch === 'without-generation' ? undefined : 7,
        hrcRunId: branch === 'own-run' ? 'run-live' : undefined,
        afterHrcSeq: 10,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 11,
        ts: new Date(now).toISOString(),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: branch === 'without-generation' ? 0 : 7,
        runId: branch === 'own-run' ? 'run-live' : 'run-recovered',
        eventKind: 'runtime.interrupted',
        payload: { reason: 'retained-audit' },
        evidenceOrigin: 'retained',
      })
      expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(true)
      hrc.db.close()
    })
    test(`T4c C fresh ordinary activity still delays timeout (${branch})`, () => {
      const now = Date.now()
      const hrc = createEvidenceHrcDb()
      const run = makeRun({
        updatedAt: isoAgo(now, 20_000),
        hostSessionId: 'hsid-retained',
        generation: branch === 'without-generation' ? undefined : 7,
        hrcRunId: branch === 'own-run' ? 'run-live' : undefined,
        afterHrcSeq: 10,
      })
      insertEvidenceEvent(hrc.db, {
        hrcSeq: 11,
        ts: new Date(now).toISOString(),
        hostSessionId: 'hsid-retained',
        scopeRef: run.scopeRef,
        laneRef: run.laneRef,
        generation: branch === 'without-generation' ? 0 : 7,
        runId: branch === 'own-run' ? 'run-live' : 'run-ordinary',
        eventKind: 'runtime.interrupted',
        payload: {},
        evidenceOrigin: null,
      })
      expect(isStaleFromLastObservedActivity(run, hrc.hrcDbPath, 10_000)).toBe(false)
      hrc.db.close()
    })
  }
})
