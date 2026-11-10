import { afterEach, describe, expect, test } from 'bun:test'
import { openInterfaceStore } from 'acp-interface-store'
import {
  cleanupFixtureDirs,
  createEvidenceHrcDb,
  createHrcDb,
  createInterfaceStore,
  createTmuxActuationFixture,
  insertAssistantMessage,
  insertCompletedPair,
  insertRunStatus,
  insertTurnCompleted,
  isoAgo,
} from '../../test/fixtures/interface-run-dispatcher.js'
import { InMemoryRunStore } from '../domain/run-store.js'
import * as dispatcherModule from './interface-run-dispatcher.js'

afterEach(cleanupFixtureDirs)

describe('interface run dispatcher completion and delivery', () => {
  test('finalizes a completed headless run even without an interface delivery source', async () => {
    const hrc = createHrcDb()
    const interfaceStore = createInterfaceStore()
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:cody:project:taskboard:task:primary',
      laneRef: 'lane:ui-concierge' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
      metadata: {
        content: 'diagnostic only: reply exactly ACP-UI-CONCIERGE-LANE-DIAG',
      },
    })
    runStore.updateRun(run.runId, {
      hrcRunId: 'hrc-run-concierge',
      hostSessionId: 'hsid-concierge',
      generation: 1,
      runtimeId: 'rt-concierge',
      transport: 'headless',
    })
    insertRunStatus(hrc.db, {
      runId: 'hrc-run-concierge',
      hostSessionId: 'hsid-concierge',
      runtimeId: 'rt-concierge',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 1,
      transport: 'headless',
      status: 'completed',
    })
    insertAssistantMessage(hrc.db, {
      hrcSeq: 11,
      hostSessionId: 'hsid-concierge',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 1,
      runId: 'hrc-run-concierge',
      text: 'ACP-UI-CONCIERGE-LANE-DIAG',
    })
    insertTurnCompleted(hrc.db, {
      hrcSeq: 12,
      hostSessionId: 'hsid-concierge',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 1,
      runId: 'hrc-run-concierge',
    })

    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrc: hrc.routes,
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toHaveLength(0)
    expect(runStore.getRun(run.runId)?.status).toBe('completed')
    interfaceStore.close()
  })

  test('immediately fails a bare terminated HRC run without stale-timeout reconciliation', async () => {
    const hrc = createHrcDb()
    const interfaceStore = createInterfaceStore()
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:cody:project:taskboard:task:terminated',
      laneRef: 'main' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
    })
    runStore.updateRun(run.runId, {
      hrcRunId: 'hrc-run-terminated',
      hostSessionId: 'hsid-terminated',
      generation: 1,
      runtimeId: 'rt-terminated',
      transport: 'headless',
    })
    insertRunStatus(hrc.db, {
      runId: 'hrc-run-terminated',
      hostSessionId: 'hsid-terminated',
      runtimeId: 'rt-terminated',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 1,
      transport: 'headless',
      status: 'terminated',
    })

    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrc: hrc.routes,
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(runStore.getRun(run.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'turn_failed',
      errorMessage: 'HRC run hrc-run-terminated ended with status: terminated',
    })
    expect(runStore.getRun(run.runId)?.errorCode).not.toBe('turn_timeout')
    interfaceStore.close()
  })

  test('tmux runs do not finalize delivery on the first assistant message before turn completion', async () => {
    const hrc = createHrcDb()
    const interfaceStore = createInterfaceStore()
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:smokey:project:agent-spaces',
      laneRef: 'main' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_live',
            conversationRef: 'channel:chan_live',
            messageRef: 'discord:message:prompt',
            replyToMessageRef: 'discord:message:prompt',
          },
        },
      },
    })
    runStore.updateRun(run.runId, {
      hostSessionId: 'hsid-live',
      generation: 7,
      runtimeId: 'rt-live',
      transport: 'tmux',
      afterHrcSeq: 10,
    })

    insertAssistantMessage(hrc.db, {
      hrcSeq: 11,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-live',
      text: 'first message, not final',
    })

    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrc: hrc.routes,
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toHaveLength(0)
    expect(runStore.getRun(run.runId)?.status).toBe('running')

    insertAssistantMessage(hrc.db, {
      hrcSeq: 12,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-live',
      text: 'final message',
    })
    insertTurnCompleted(hrc.db, {
      hrcSeq: 13,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-live',
    })

    await dispatcher.runOnce()

    const [delivery] = interfaceStore.deliveries.listQueuedForGateway('discord_prod')
    expect(delivery).toMatchObject({
      runId: run.runId,
      bodyText: 'final message',
    })
    expect(runStore.getRun(run.runId)?.status).toBe('completed')
    interfaceStore.close()
  })

  test('tmux follow-up ignores a previous run completion after the dispatch fence', async () => {
    const hrc = createHrcDb()
    const interfaceStore = createInterfaceStore()
    const runStore = new InMemoryRunStore()
    const sessionRef = {
      scopeRef: 'agent:smokey:project:agent-spaces',
      laneRef: 'main' as const,
    }
    const run = runStore.createRun({
      sessionRef,
      status: 'running',
      metadata: {
        meta: {
          interfaceSource: {
            gatewayId: 'discord_prod',
            bindingId: 'ifb_live',
            conversationRef: 'channel:chan_live',
            messageRef: 'discord:message:prompt',
            replyToMessageRef: 'discord:message:prompt',
          },
        },
      },
    })
    runStore.updateRun(run.runId, {
      hostSessionId: 'hsid-live',
      generation: 7,
      runtimeId: 'rt-live',
      transport: 'tmux',
      afterHrcSeq: 20,
    })

    insertTurnCompleted(hrc.db, {
      hrcSeq: 21,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-previous',
    })
    insertAssistantMessage(hrc.db, {
      hrcSeq: 22,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-follow-up',
      text: 'follow-up still running',
    })

    const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
      runStore,
      interfaceStore,
      hrc: hrc.routes,
      config: { intervalMs: 1, staleTimeoutMs: 60_000 },
    })

    await dispatcher.runOnce()

    expect(interfaceStore.deliveries.listQueuedForGateway('discord_prod')).toHaveLength(0)
    expect(runStore.getRun(run.runId)?.status).toBe('running')

    insertTurnCompleted(hrc.db, {
      hrcSeq: 23,
      hostSessionId: 'hsid-live',
      scopeRef: sessionRef.scopeRef,
      laneRef: sessionRef.laneRef,
      generation: 7,
      runId: 'hrc-run-follow-up',
    })

    await dispatcher.runOnce()

    const [delivery] = interfaceStore.deliveries.listQueuedForGateway('discord_prod')
    expect(delivery).toMatchObject({
      runId: run.runId,
      bodyText: 'follow-up still running',
    })
    expect(runStore.getRun(run.runId)?.status).toBe('completed')
    interfaceStore.close()
  })

  test('T1 retained completion cannot finalize or enqueue delivery', async () => {
    const hrc = createEvidenceHrcDb()
    // This fences retained evidence, not staleness. Keep a loaded runner from
    // expiring the fresh run on the helper's 10 ms stale deadline.
    const fx = createTmuxActuationFixture({
      hrc: hrc.routes,
      generation: 7,
      staleTimeoutMs: 10 * 60_000,
    })
    insertCompletedPair(hrc.db, {
      firstSeq: 11,
      text: 'OLD-REPLY',
      runId: 'run-hist',
      evidenceOrigin: 'retained',
      ts: isoAgo(Date.now(), 2 * 60 * 60_000),
    })

    await fx.dispatcher.runOnce()

    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('running')
    expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toHaveLength(0)
    expect(JSON.stringify(fx.runStore.getRun(fx.run.runId)?.metadata)).not.toContain(
      'deliveryRequestId'
    )
    expect(hrc.db.query('SELECT hrc_seq FROM hrc_events').all()).toHaveLength(2)
    fx.interfaceStore.close()
    hrc.db.close()
  })

  for (const control of [
    { id: 'C', replayed: false },
    { id: "C'", replayed: true },
  ]) {
    test(`T1 ${control.id} ordinary-origin completion still finalizes and delivers`, async () => {
      const hrc = createEvidenceHrcDb()
      const fx = createTmuxActuationFixture({ hrc: hrc.routes, generation: 7 })
      insertCompletedPair(hrc.db, {
        firstSeq: 11,
        text: 'OLD-REPLY',
        runId: 'run-control',
        evidenceOrigin: null,
        replayed: control.replayed,
      })

      await fx.dispatcher.runOnce()

      expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('completed')
      expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toMatchObject([
        { bodyText: 'OLD-REPLY' },
      ])
      fx.interfaceStore.close()
      hrc.db.close()
    })
  }

  test('T1b a live completion after retained history finalizes exactly once with live text', async () => {
    const hrc = createEvidenceHrcDb()
    const fx = createTmuxActuationFixture({ hrc: hrc.routes, generation: 7 })
    insertCompletedPair(hrc.db, {
      firstSeq: 11,
      text: 'OLD-REPLY',
      runId: 'run-hist',
      evidenceOrigin: 'retained',
    })
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
    expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toHaveLength(1)
    fx.interfaceStore.close()
    hrc.db.close()
  })

  test('K1 own terminal run may finalize from its retained final output', async () => {
    const hrc = createEvidenceHrcDb()
    const fx = createTmuxActuationFixture({
      hrc: hrc.routes,
      generation: 7,
      hrcRunId: 'run-own',
    })
    insertRunStatus(hrc.db, {
      runId: 'run-own',
      hostSessionId: 'hsid-retained',
      runtimeId: 'rt-retained',
      scopeRef: fx.sessionRef.scopeRef,
      laneRef: fx.sessionRef.laneRef,
      generation: 7,
      transport: 'headless',
      status: 'completed',
    })
    insertCompletedPair(hrc.db, {
      firstSeq: 11,
      text: 'RECOVERED-OWN-OUTPUT',
      runId: 'run-own',
      evidenceOrigin: 'retained',
    })

    await fx.dispatcher.runOnce()

    expect(fx.runStore.getRun(fx.run.runId)?.status).toBe('completed')
    expect(fx.interfaceStore.deliveries.listByRun(fx.run.runId)).toMatchObject([
      { bodyText: 'RECOVERED-OWN-OUTPUT' },
    ])
    fx.interfaceStore.close()
    hrc.db.close()
  })
})

// HRC is the only writer after startup in this regression: no ACP wake hint.
test('commit bus keeps reconciliation cadence for an HRC-only completion', async () => {
  const { StoreCommitBus } = await import('../store-commit-bus.js')
  const hrc = createHrcDb()
  const interfaceStore = openInterfaceStore({ dbPath: ':memory:' })
  const runStore = new InMemoryRunStore()
  const sessionRef = {
    scopeRef: 'agent:cody:project:agent-control-plane:task:T-12582',
    laneRef: 'main' as const,
  }
  const run = runStore.createRun({ sessionRef, status: 'running' })
  runStore.updateRun(run.runId, {
    hrcRunId: 'bus-hrc-run',
    hostSessionId: 'bus-host',
    generation: 1,
    runtimeId: 'bus-runtime',
    transport: 'headless',
  })
  insertRunStatus(hrc.db, {
    runId: 'bus-hrc-run',
    hostSessionId: 'bus-host',
    runtimeId: 'bus-runtime',
    ...sessionRef,
    generation: 1,
    transport: 'headless',
    status: 'running',
  })
  const bus = new StoreCommitBus()
  const dispatcher = dispatcherModule.createInterfaceRunDispatcher({
    commitBus: bus,
    runStore,
    interfaceStore,
    hrc: hrc.routes,
    config: { intervalMs: 2000, staleTimeoutMs: 60000 },
  })
  try {
    dispatcher.start()
    await Bun.sleep(30)
    expect(runStore.getRun(run.runId)?.status).toBe('running')
    const version = bus.version('runs')
    const start = performance.now()
    hrc.db
      .query("UPDATE runs SET status = 'completed', completed_at = ? WHERE run_id = ?")
      .run(new Date().toISOString(), 'bus-hrc-run')
    while (runStore.getRun(run.runId)?.status === 'running' && performance.now() - start < 2100)
      await Bun.sleep(5)
    expect(runStore.getRun(run.runId)?.status).toBe('completed')
    expect(performance.now() - start).toBeLessThan(2000)
    expect(bus.version('runs')).toBe(version)
  } finally {
    await dispatcher.stop()
    interfaceStore.close()
    hrc.db.close()
  }
})
