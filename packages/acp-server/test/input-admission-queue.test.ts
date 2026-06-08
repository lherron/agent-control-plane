import { describe, expect, test } from 'bun:test'
import { createInMemoryAdminStore } from 'acp-admin-store'

import {
  type AcpServerDeps,
  InMemoryInputAdmissionStore,
  InMemoryInputApplicationStore,
  InMemoryInputQueueStore,
  InMemorySessionAdmissionSequenceStore,
} from '../src/index.js'
import { createInputQueueDispatcher } from '../src/integration/input-queue-dispatcher.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

function createAdmissionStores() {
  return {
    adminStore: createInMemoryAdminStore(),
    inputAdmissionStore: new InMemoryInputAdmissionStore(),
    inputApplicationStore: new InMemoryInputApplicationStore(),
    inputQueueStore: new InMemoryInputQueueStore(),
    sessionAdmissionSequenceStore: new InMemorySessionAdmissionSequenceStore(),
  }
}

describe('input admission queue', () => {
  test('busy ordinary input queues a future run and replays the original admission', async () => {
    const stores = createAdmissionStores()
    const launchCalls: LaunchCall[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-queue:role:implementer`,
          laneRef: 'main',
        }

        const first = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'queue-first',
            sessionRef,
            content: 'first input',
          },
        })
        const firstPayload = await fixture.json<{ run: { runId: string; status: string } }>(first)
        expect(first.status).toBe(201)
        expect(firstPayload.run.status).toBe('running')

        const secondBody = {
          idempotencyKey: 'queue-second',
          sessionRef,
          content: 'second input',
        }
        const second = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: secondBody,
        })
        const replay = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: secondBody,
        })
        const secondPayload = await fixture.json<{
          run: { runId: string; status: string }
          admission: { kind: string; queueItemId: string; runId: string }
          currentState: { queueStatus: string }
        }>(second)
        const replayPayload = await fixture.json<{
          run: { runId: string; status: string }
          admission: { kind: string; queueItemId: string; runId: string }
        }>(replay)

        expect(second.status).toBe(201)
        expect(replay.status).toBe(200)
        expect(secondPayload.admission.kind).toBe('queued_run')
        expect(secondPayload.currentState.queueStatus).toBe('queued')
        expect(secondPayload.run.status).toBe('queued')
        expect(replayPayload.admission).toEqual(secondPayload.admission)
        expect(launchCalls).toHaveLength(1)

        fixture.runStore.updateRun(firstPayload.run.runId, { status: 'completed' })
        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/larry',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            launchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return { runId: input.acpRunId ?? 'run-fallback', sessionId: 'session-queue' }
          },
          inputQueuePolicy: {},
          config: { intervalMs: 60_000 },
        })
        await dispatcher.runOnce()

        expect(launchCalls).toHaveLength(2)
        expect(launchCalls[1]?.acpRunId).toBe(secondPayload.run.runId)
        expect(fixture.runStore.getRun(secondPayload.run.runId)?.status).toBe('running')
        expect(stores.inputQueueStore.getById(secondPayload.admission.queueItemId)?.status).toBe(
          'running'
        )
        expect(
          stores.adminStore.systemEvents
            .list({ projectId: fixture.seed.projectId })
            .map((event) => event.kind)
        ).toEqual(expect.arrayContaining(['input.queued', 'input.dispatching', 'input.started']))
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          launchCalls.push(input)
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return { runId: input.acpRunId ?? 'run-fallback', sessionId: 'session-first' }
        },
      }
    )
  })

  test('stale pending runs without HRC correlation do not block queued dispatch forever', async () => {
    const stores = createAdmissionStores()
    const initialLaunchCalls: LaunchCall[] = []
    const queuedLaunchCalls: LaunchCall[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-stale-pending:role:implementer`,
          laneRef: 'main',
        }

        const first = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'stale-pending-first',
            sessionRef,
            content: 'first input never records HRC correlation',
          },
        })
        const firstPayload = await fixture.json<{ run: { runId: string; status: string } }>(first)
        expect(firstPayload.run.status).toBe('pending')

        const second = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'stale-pending-second',
            sessionRef,
            content: 'second input should dispatch after stale blocker fails',
          },
        })
        const secondPayload = await fixture.json<{
          run: { runId: string; status: string }
          admission: { queueItemId: string }
        }>(second)
        expect(secondPayload.run.status).toBe('queued')

        await Bun.sleep(2)
        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/larry',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            queuedLaunchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, {
                status: 'running',
                hrcRunId: 'hrc-stale-pending-second',
                hostSessionId: 'hsid-stale-pending-second',
                runtimeId: 'rt-stale-pending-second',
              })
            }
            return {
              runId: 'hrc-stale-pending-second',
              sessionId: 'hsid-stale-pending-second',
            }
          },
          inputQueuePolicy: {},
          config: { intervalMs: 60_000, stalePendingRunTimeoutMs: 1 },
        })
        await dispatcher.runOnce()

        expect(fixture.runStore.getRun(firstPayload.run.runId)).toMatchObject({
          status: 'failed',
          errorCode: 'dispatch_timeout',
        })
        expect(fixture.runStore.getRun(secondPayload.run.runId)?.status).toBe('running')
        expect(stores.inputQueueStore.getById(secondPayload.admission.queueItemId)?.status).toBe(
          'running'
        )
        expect(initialLaunchCalls).toHaveLength(1)
        expect(queuedLaunchCalls).toHaveLength(1)
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          initialLaunchCalls.push(input)
          return { runId: 'hrc-stale-pending-first', sessionId: 'session-stale-pending-first' }
        },
      }
    )
  })

  test('terminal dispatching queue head is reconciled before dispatching the next queued item', async () => {
    const stores = createAdmissionStores()
    const queuedLaunchCalls: LaunchCall[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-terminal-head:role:implementer`,
          laneRef: 'main',
        }

        const first = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'terminal-head-first',
            sessionRef,
            content: 'active input',
          },
        })
        const firstPayload = await fixture.json<{ run: { runId: string } }>(first)

        const second = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'terminal-head-second',
            sessionRef,
            content: 'queued item that completes while dispatching',
          },
        })
        const secondPayload = await fixture.json<{
          run: { runId: string }
          admission: { queueItemId: string }
        }>(second)

        const third = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'terminal-head-third',
            sessionRef,
            content: 'next queued item',
          },
        })
        const thirdPayload = await fixture.json<{
          run: { runId: string }
          admission: { queueItemId: string }
        }>(third)

        fixture.runStore.updateRun(firstPayload.run.runId, { status: 'completed' })
        fixture.runStore.updateRun(secondPayload.run.runId, { status: 'completed' })
        stores.inputQueueStore.update(secondPayload.admission.queueItemId, {
          status: 'dispatching',
        })

        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/larry',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            queuedLaunchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return { runId: input.acpRunId ?? 'run-fallback', sessionId: 'session-terminal-head' }
          },
          inputQueuePolicy: {},
          config: { intervalMs: 60_000 },
        })
        await dispatcher.runOnce()

        expect(stores.inputQueueStore.getById(secondPayload.admission.queueItemId)?.status).toBe(
          'completed'
        )
        expect(fixture.runStore.getRun(thirdPayload.run.runId)?.status).toBe('running')
        expect(stores.inputQueueStore.getById(thirdPayload.admission.queueItemId)?.status).toBe(
          'running'
        )
        expect(queuedLaunchCalls).toHaveLength(1)
        expect(queuedLaunchCalls[0]?.acpRunId).toBe(thirdPayload.run.runId)
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return { runId: input.acpRunId ?? 'hrc-terminal-head', sessionId: 'hsid-terminal-head' }
        },
      }
    )
  })

  test('stale pending runs with partial HRC correlation no longer block queued dispatch', async () => {
    const stores = createAdmissionStores()
    const initialLaunchCalls: LaunchCall[] = []
    const queuedLaunchCalls: LaunchCall[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-partial-corr:role:implementer`,
          laneRef: 'main',
        }

        const first = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'partial-corr-first',
            sessionRef,
            content: 'first input wedges with partial HRC correlation',
          },
        })
        const firstPayload = await fixture.json<{ run: { runId: string; status: string } }>(first)
        expect(firstPayload.run.status).toBe('pending')

        // Simulate real-launcher writing hostSessionId after resolveSession but before
        // dispatchTurn completes — leaves the run with partial correlation only.
        fixture.runStore.updateRun(firstPayload.run.runId, {
          hostSessionId: 'hsid-partial-corr-first',
        })

        const second = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'partial-corr-second',
            sessionRef,
            content: 'second input should dispatch after partial blocker is failed',
          },
        })
        const secondPayload = await fixture.json<{
          run: { runId: string; status: string }
          admission: { queueItemId: string }
        }>(second)
        expect(secondPayload.run.status).toBe('queued')

        await Bun.sleep(2)
        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/larry',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            queuedLaunchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, {
                status: 'running',
                hrcRunId: 'hrc-partial-corr-second',
                hostSessionId: 'hsid-partial-corr-second',
                runtimeId: 'rt-partial-corr-second',
              })
            }
            return {
              runId: 'hrc-partial-corr-second',
              sessionId: 'hsid-partial-corr-second',
            }
          },
          inputQueuePolicy: {},
          config: { intervalMs: 60_000, stalePendingRunTimeoutMs: 1 },
        })
        await dispatcher.runOnce()

        const failedFirst = fixture.runStore.getRun(firstPayload.run.runId)
        expect(failedFirst?.status).toBe('failed')
        expect(failedFirst?.errorCode).toBe('dispatch_timeout')
        expect(failedFirst?.errorMessage).toContain('partial HRC session correlation')
        expect(fixture.runStore.getRun(secondPayload.run.runId)?.status).toBe('running')
        expect(stores.inputQueueStore.getById(secondPayload.admission.queueItemId)?.status).toBe(
          'running'
        )
        expect(initialLaunchCalls).toHaveLength(1)
        expect(queuedLaunchCalls).toHaveLength(1)
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          initialLaunchCalls.push(input)
          return { runId: 'hrc-partial-corr-first', sessionId: 'hsid-partial-corr-first' }
        },
      }
    )
  })

  test('expired-lease dispatching head is failed and the next queued item dispatches', async () => {
    const stores = createAdmissionStores()
    const queuedLaunchCalls: LaunchCall[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-lease:role:implementer`,
          laneRef: 'main',
        }

        // First input launches directly; no queue item is created for it.
        const first = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'lease-first',
            sessionRef,
            content: 'first input launches and stays running',
          },
        })
        const firstPayload = await fixture.json<{ run: { runId: string } }>(first)

        // Second input enters the queue; we'll wedge this one as a stuck dispatching head.
        const second = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'lease-second',
            sessionRef,
            content: 'second input wedges as a stuck dispatching head',
          },
        })
        const secondPayload = await fixture.json<{
          run: { runId: string }
          admission: { queueItemId: string }
        }>(second)

        // Third input enters the queue behind the wedged head.
        const third = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'lease-third',
            sessionRef,
            content: 'third input should dispatch once the stuck head is reaped',
          },
        })
        const thirdPayload = await fixture.json<{
          run: { runId: string }
          admission: { queueItemId: string }
        }>(third)

        // Mark the first run as completed so it does not block dispatch on its own merits.
        fixture.runStore.updateRun(firstPayload.run.runId, { status: 'completed' })

        // Simulate a wedged dispatcher: queued head was leased but never reached terminal state.
        // Leave the run in a non-terminal state to verify the lease-timeout path fails it.
        const oldLease = new Date(Date.now() - 60_000).toISOString()
        stores.inputQueueStore.update(secondPayload.admission.queueItemId, {
          status: 'dispatching',
          leasedAt: oldLease,
          leaseOwner: 'wedged-dispatcher',
        })
        fixture.runStore.updateRun(secondPayload.run.runId, { status: 'pending' })

        await Bun.sleep(2)
        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/larry',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            queuedLaunchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return { runId: input.acpRunId ?? 'run-lease', sessionId: 'session-lease' }
          },
          inputQueuePolicy: {},
          config: { intervalMs: 60_000, leaseTimeoutMs: 1 },
        })
        await dispatcher.runOnce()

        const reapedQueueItem = stores.inputQueueStore.getById(secondPayload.admission.queueItemId)
        expect(reapedQueueItem?.status).toBe('failed')
        expect(reapedQueueItem?.lastErrorCode).toBe('lease_timeout')
        const reapedRun = fixture.runStore.getRun(secondPayload.run.runId)
        expect(reapedRun?.status).toBe('failed')
        expect(reapedRun?.errorCode).toBe('lease_timeout')

        expect(fixture.runStore.getRun(thirdPayload.run.runId)?.status).toBe('running')
        expect(stores.inputQueueStore.getById(thirdPayload.admission.queueItemId)?.status).toBe(
          'running'
        )
        expect(queuedLaunchCalls).toHaveLength(1)
        expect(queuedLaunchCalls[0]?.acpRunId).toBe(thirdPayload.run.runId)
        const events = stores.adminStore.systemEvents.list({ projectId: fixture.seed.projectId })
        const leaseExpiredEvent = events.find((e) => e.kind === 'input.queue.lease_expired')
        expect(leaseExpiredEvent).toBeDefined()
        expect(leaseExpiredEvent?.payload).toMatchObject({
          queueItemId: secondPayload.admission.queueItemId,
          runId: secondPayload.run.runId,
          leasedAt: oldLease,
          leaseOwner: 'wedged-dispatcher',
          timeoutMs: 1,
        })
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return { runId: input.acpRunId ?? 'hrc-lease-first', sessionId: 'hsid-lease-first' }
        },
      }
    )
  })

  test('per-session-head iteration prevents page-50 starvation across many sessions', async () => {
    const stores = createAdmissionStores()
    const launchedRunIds: string[] = []

    await withWiredServer(
      async (fixture) => {
        // Create 60 distinct sessions, each with one queued item.
        const sessionRefs = Array.from({ length: 60 }, (_, i) => ({
          scopeRef: `agent:bulk-${i.toString().padStart(3, '0')}:project:${fixture.seed.projectId}:task:T-bulk:role:implementer`,
          laneRef: 'main',
        }))

        const firstRunIds: string[] = []
        const queuedRunIds: string[] = []
        for (let i = 0; i < sessionRefs.length; i++) {
          const sessionRef = sessionRefs[i]!
          const first = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: {
              idempotencyKey: `bulk-${i}-first`,
              sessionRef,
              content: `session ${i} first input`,
            },
          })
          const firstPayload = await fixture.json<{ run: { runId: string } }>(first)
          firstRunIds.push(firstPayload.run.runId)

          // Submit second WHILE first is running so the second is admitted as queued.
          const second = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: {
              idempotencyKey: `bulk-${i}-second`,
              sessionRef,
              content: `session ${i} queued`,
            },
          })
          const secondPayload = await fixture.json<{ run: { runId: string } }>(second)
          queuedRunIds.push(secondPayload.run.runId)
        }

        // Now mark each first run completed so the queued items are eligible for dispatch.
        for (const runId of firstRunIds) {
          fixture.runStore.updateRun(runId, { status: 'completed' })
        }

        // Sanity: all 60 sessions have a queued item.
        const totalQueued = queuedRunIds.filter(
          (id) => fixture.runStore.getRun(id)?.status === 'queued'
        ).length
        expect(totalQueued).toBe(60)

        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/bulk',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            if (input.acpRunId !== undefined) {
              launchedRunIds.push(input.acpRunId)
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return { runId: input.acpRunId ?? 'run-bulk', sessionId: 'session-bulk' }
          },
          inputQueuePolicy: {},
          config: { intervalMs: 60_000 },
        })
        await dispatcher.runOnce()

        // All 60 queued items must be dispatched in a single tick — none starved by the
        // legacy first-page-of-50 cap.
        expect(launchedRunIds).toHaveLength(60)
        for (const runId of queuedRunIds) {
          expect(launchedRunIds).toContain(runId)
          expect(fixture.runStore.getRun(runId)?.status).toBe('running')
        }
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/bulk',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return { runId: input.acpRunId ?? 'hrc-bulk-first', sessionId: 'hsid-bulk-first' }
        },
      }
    )
  })

  test('a pre-launcher dispatchItem throw is logged and other sessions still get a chance', async () => {
    const stores = createAdmissionStores()
    const launchCalls: LaunchCall[] = []
    const consoleErrors: string[] = []
    const originalConsoleError = console.error
    console.error = ((...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '))
    }) as typeof console.error

    try {
      await withWiredServer(
        async (fixture) => {
          const sessionA = {
            scopeRef: `agent:alice:project:${fixture.seed.projectId}:task:T-throw:role:implementer`,
            laneRef: 'main',
          }
          const sessionB = {
            scopeRef: `agent:bob:project:${fixture.seed.projectId}:task:T-throw:role:implementer`,
            laneRef: 'main',
          }

          const a1 = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: {
              idempotencyKey: 'throw-a1',
              sessionRef: sessionA,
              content: 'session A first input',
            },
          })
          const a1Payload = await fixture.json<{ run: { runId: string } }>(a1)
          const a2 = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: {
              idempotencyKey: 'throw-a2',
              sessionRef: sessionA,
              content: 'session A queued',
            },
          })
          const a2Payload = await fixture.json<{
            run: { runId: string }
            admission: { queueItemId: string }
          }>(a2)

          const b1 = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: {
              idempotencyKey: 'throw-b1',
              sessionRef: sessionB,
              content: 'session B first input',
            },
          })
          const b1Payload = await fixture.json<{ run: { runId: string } }>(b1)
          const b2 = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: {
              idempotencyKey: 'throw-b2',
              sessionRef: sessionB,
              content: 'session B queued',
            },
          })
          const b2Payload = await fixture.json<{
            run: { runId: string }
            admission: { queueItemId: string }
          }>(b2)

          fixture.runStore.updateRun(a1Payload.run.runId, { status: 'completed' })
          fixture.runStore.updateRun(b1Payload.run.runId, { status: 'completed' })

          // runtimeResolver runs BEFORE the launcher try/catch in dispatchItem, so a throw
          // here surfaces from dispatchItem itself — exercising the new runOnce-level
          // try/catch fairness guard rather than the existing in-dispatch launch_failed path.
          const dispatcher = createInputQueueDispatcher({
            adminStore: stores.adminStore,
            hrcClient: undefined,
            inputAdmissionStore: stores.inputAdmissionStore,
            inputQueueStore: stores.inputQueueStore,
            runStore: fixture.runStore,
            runtimeResolver: async (sessionRef) => {
              if (sessionRef.scopeRef.startsWith('agent:alice:')) {
                throw new Error('boom: simulated runtimeResolver failure for session A')
              }
              return {
                agentRoot: '/tmp/agents/bob',
                projectRoot: '/tmp/project',
                cwd: '/tmp/project',
                runMode: 'task',
                bundle: { kind: 'compose', compose: [] },
                harness: { provider: 'openai', interactive: true },
              }
            },
            launchRoleScopedRun: async (input) => {
              launchCalls.push(input)
              if (input.acpRunId !== undefined) {
                input.runStore?.updateRun(input.acpRunId, { status: 'running' })
              }
              return { runId: input.acpRunId ?? 'run-throw', sessionId: 'session-throw' }
            },
            inputQueuePolicy: {},
            config: { intervalMs: 60_000 },
          })
          await dispatcher.runOnce()

          // Session A's pre-launcher throw bubbles through dispatchItem; the queue item is
          // left transitioned (run=pending, queue=dispatching) but the runOnce loop must
          // still proceed to session B and dispatch it.
          expect(stores.inputQueueStore.getById(b2Payload.admission.queueItemId)?.status).toBe(
            'running'
          )
          expect(fixture.runStore.getRun(b2Payload.run.runId)?.status).toBe('running')
          expect(launchCalls.map((c) => c.acpRunId)).toContain(b2Payload.run.runId)

          // Session A never reached the launcher.
          expect(launchCalls.map((c) => c.acpRunId)).not.toContain(a2Payload.run.runId)

          // The thrown error was surfaced via the new runOnce try/catch.
          const dispatcherErrors = consoleErrors.filter((line) =>
            line.includes('[input-queue-dispatcher] error dispatching queue item')
          )
          expect(dispatcherErrors.length).toBeGreaterThan(0)
          expect(dispatcherErrors[0]).toContain(a2Payload.admission.queueItemId)
          expect(dispatcherErrors[0]).toContain('boom: simulated runtimeResolver failure')
        },
        {
          ...stores,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/alice',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return { runId: input.acpRunId ?? 'hrc-throw-first', sessionId: 'hsid-throw-first' }
          },
        }
      )
    } finally {
      console.error = originalConsoleError
    }
  })

  test('queue max depth rejects additional queued work', async () => {
    const stores = createAdmissionStores()

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-depth:role:implementer`,
          laneRef: 'main',
        }

        await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'depth-first',
            sessionRef,
            content: 'first input',
          },
        })
        const queued = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'depth-second',
            sessionRef,
            content: 'second input',
          },
        })
        const rejected = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'depth-third',
            sessionRef,
            content: 'third input',
          },
        })
        const rejectedPayload = await fixture.json<{
          admission: { kind: string }
          currentState: { reason: string }
        }>(rejected)

        expect(queued.status).toBe(201)
        expect(rejected.status).toBe(201)
        expect(rejectedPayload.admission.kind).toBe('rejected')
        expect(rejectedPayload.currentState.reason).toBe('input_queue_depth_exceeded')
        expect(
          stores.inputQueueStore.listForSession(sessionRef.scopeRef, sessionRef.laneRef)
        ).toHaveLength(1)
      },
      {
        ...stores,
        inputQueuePolicy: { maxDepth: 1 },
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return { runId: input.acpRunId ?? 'run-fallback', sessionId: 'session-depth' }
        },
      }
    )
  })

  test('pinned queued input expires after session generation changes', async () => {
    const stores = createAdmissionStores()
    const launchCalls: LaunchCall[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-pin:role:implementer`,
          laneRef: 'main',
        }

        const first = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'pin-first',
            sessionRef,
            content: 'first input',
          },
        })
        const firstPayload = await fixture.json<{ run: { runId: string } }>(first)
        const second = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'pin-second',
            sessionRef,
            content: 'second input',
            intent: { kind: 'new_work', resetPolicy: 'pin_generation' },
          },
        })
        const secondPayload = await fixture.json<{
          run: { runId: string }
          admission: { queueItemId: string }
        }>(second)
        const queuedItem = stores.inputQueueStore.getById(secondPayload.admission.queueItemId)

        expect(queuedItem?.resetPolicy).toBe('pin_generation')
        expect(queuedItem?.expectedGeneration).toBe(3)

        fixture.runStore.updateRun(firstPayload.run.runId, { status: 'completed' })
        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: {
            resolveSession: async () => ({ found: true, hostSessionId: 'hsid-pin', generation: 4 }),
          } as never,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/larry',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          inputQueuePolicy: {},
          launchRoleScopedRun: async (input) => {
            launchCalls.push(input)
            return { runId: input.acpRunId ?? 'run-fallback', sessionId: 'session-pin' }
          },
          config: { intervalMs: 60_000 },
        })
        await dispatcher.runOnce()

        expect(launchCalls).toHaveLength(1)
        expect(stores.inputQueueStore.getById(secondPayload.admission.queueItemId)?.status).toBe(
          'expired'
        )
        expect(fixture.runStore.getRun(secondPayload.run.runId)?.status).toBe('cancelled')
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          launchCalls.push(input)
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, {
              status: 'running',
              hostSessionId: 'hsid-pin',
              generation: 3,
            })
          }
          return { runId: input.acpRunId ?? 'run-fallback', sessionId: 'session-pin' }
        },
      }
    )
  })

  test('queue TTL expires stale queued work before dispatch', async () => {
    const stores = createAdmissionStores()
    const launchCalls: LaunchCall[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-ttl:role:implementer`,
          laneRef: 'main',
        }

        const first = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'ttl-first',
            sessionRef,
            content: 'first input',
          },
        })
        const firstPayload = await fixture.json<{ run: { runId: string } }>(first)
        const second = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'ttl-second',
            sessionRef,
            content: 'second input',
          },
        })
        const secondPayload = await fixture.json<{
          run: { runId: string }
          admission: { queueItemId: string }
        }>(second)

        await Bun.sleep(5)
        fixture.runStore.updateRun(firstPayload.run.runId, { status: 'completed' })
        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/larry',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          inputQueuePolicy: { ttlMs: 1 },
          launchRoleScopedRun: async (input) => {
            launchCalls.push(input)
            return { runId: input.acpRunId ?? 'run-fallback', sessionId: 'session-ttl' }
          },
          config: { intervalMs: 60_000 },
        })
        await dispatcher.runOnce()

        expect(launchCalls).toHaveLength(1)
        expect(stores.inputQueueStore.getById(secondPayload.admission.queueItemId)?.status).toBe(
          'expired'
        )
        expect(fixture.runStore.getRun(secondPayload.run.runId)?.status).toBe('cancelled')
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          launchCalls.push(input)
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return { runId: input.acpRunId ?? 'run-fallback', sessionId: 'session-ttl' }
        },
      }
    )
  })

  test('explicit active-run contribution queues fallback quietly when HRC recommends queue', async () => {
    const stores = createAdmissionStores()
    const launchCalls: LaunchCall[] = []
    const contributionCalls: unknown[] = []
    const consoleErrors: string[] = []
    const originalConsoleError = console.error
    console.error = ((...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '))
    }) as typeof console.error

    try {
      await withWiredServer(
        async (fixture) => {
          const sessionRef = {
            scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-contrib:role:implementer`,
            laneRef: 'main',
          }

          const first = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: {
              idempotencyKey: 'contrib-first',
              sessionRef,
              content: 'start active run',
            },
          })
          const firstPayload = await fixture.json<{ run: { runId: string; status: string } }>(first)
          expect(firstPayload.run.status).toBe('running')

          const contributionBody = {
            idempotencyKey: 'contrib-second',
            sessionRef,
            content: 'append this if supported',
            intent: {
              kind: 'contribute_to_active_run',
              fallback: 'queue',
              contributionSemantics: 'append_context',
            },
          }
          const contribution = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: contributionBody,
          })
          const replay = await fixture.request({
            method: 'POST',
            path: '/v1/inputs',
            body: contributionBody,
          })
          const payload = await fixture.json<{
            run: { runId: string; status: string }
            inputApplication: { inputApplicationId: string; status: string; targetRunId: string }
            admission: {
              kind: string
              runId: string
              queueItemId: string
              inputApplicationId: string
            }
            currentState: { queueStatus: string; applicationStatus: string; reason: string }
          }>(contribution)
          const replayPayload = await fixture.json<{ admission: unknown }>(replay)

          expect(contribution.status).toBe(201)
          expect(replay.status).toBe(200)
          expect(payload.admission.kind).toBe('queued_run')
          expect(payload.admission.inputApplicationId).toBe(
            payload.inputApplication.inputApplicationId
          )
          expect(payload.inputApplication.status).toBe('failed')
          expect(payload.inputApplication.targetRunId).toBe(firstPayload.run.runId)
          expect(payload.currentState).toEqual(
            expect.objectContaining({
              queueStatus: 'queued',
              applicationStatus: 'failed',
              reason: 'feature_disabled',
            })
          )
          expect(payload.run.status).toBe('queued')
          expect(stores.inputQueueStore.getById(payload.admission.queueItemId)?.resetPolicy).toBe(
            'expire_on_generation_change'
          )
          expect(replayPayload.admission).toEqual(payload.admission)
          expect(contributionCalls).toHaveLength(1)
          expect(contributionCalls[0]).toEqual(
            expect.objectContaining({
              inputApplicationId: payload.inputApplication.inputApplicationId,
              expectedRunId: 'hrc-active',
              prompt: 'append this if supported',
            })
          )
          expect(launchCalls).toHaveLength(1)
          expect(
            stores.adminStore.systemEvents
              .list({ projectId: fixture.seed.projectId })
              .map((event) => event.kind)
          ).toContain('input.queued')
          expect(consoleErrors).toEqual([])
        },
        {
          ...stores,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/larry',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'compose', compose: [] },
            harness: { provider: 'openai', interactive: true },
          }),
          launchRoleScopedRun: async (input) => {
            launchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, {
                status: 'running',
                hrcRunId: 'hrc-active',
                hostSessionId: 'hsid-active',
                generation: 3,
                runtimeId: 'rt-active',
              })
            }
            return { runId: 'hrc-active', sessionId: 'hsid-active' }
          },
          hrcClient: {
            submitActiveRunContribution: async (request: unknown) => {
              contributionCalls.push(request)
              const inputApplicationId = (request as { inputApplicationId: string })
                .inputApplicationId
              return {
                status: 'queue_recommended',
                inputApplicationId,
                hostSessionId: 'hsid-active',
                generation: 3,
                runtimeId: 'rt-active',
                runId: 'hrc-active',
                capability: { supported: false, reason: 'feature_disabled' },
              }
            },
          } as never,
        }
      )
    } finally {
      console.error = originalConsoleError
    }
  })

  test('accepted active-run contribution does not consume ordinary busy FIFO sequence', async () => {
    const stores = createAdmissionStores()
    const contributionCalls: unknown[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-mixed-fifo:role:implementer`,
          laneRef: 'main',
        }

        await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-active',
            sessionRef,
            content: 'start active run',
          },
        })

        const ordinaryOne = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-ordinary-1',
            sessionRef,
            content: 'ordinary one',
          },
        })
        const ordinaryTwo = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-ordinary-2',
            sessionRef,
            content: 'ordinary two',
          },
        })
        const contribution = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-contribution',
            sessionRef,
            content: 'contribution follows active run',
            intent: { kind: 'contribute_to_active_run', fallback: 'reject' },
          },
        })
        const ordinaryThree = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'mixed-ordinary-3',
            sessionRef,
            content: 'ordinary three',
          },
        })

        const ordinaryOnePayload = await fixture.json<{
          admission: { kind: string }
          currentState: { seq: number }
        }>(ordinaryOne)
        const ordinaryTwoPayload = await fixture.json<{
          admission: { kind: string }
          currentState: { seq: number }
        }>(ordinaryTwo)
        const contributionPayload = await fixture.json<{
          inputApplication: { inputApplicationId: string; status: string }
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; seq?: number | undefined }
        }>(contribution)
        const ordinaryThreePayload = await fixture.json<{
          admission: { kind: string }
          currentState: { seq: number }
        }>(ordinaryThree)

        expect(ordinaryOnePayload.admission.kind).toBe('queued_run')
        expect(ordinaryTwoPayload.admission.kind).toBe('queued_run')
        expect(contributionPayload.admission.kind).toBe('accepted_in_flight')
        expect(contributionPayload.currentState).toEqual(
          expect.objectContaining({ applicationStatus: 'accepted' })
        )
        expect(contributionPayload.currentState.seq).toBeUndefined()
        expect(ordinaryThreePayload.admission.kind).toBe('queued_run')
        expect([
          ordinaryOnePayload.currentState.seq,
          ordinaryTwoPayload.currentState.seq,
          ordinaryThreePayload.currentState.seq,
        ]).toEqual([
          ordinaryOnePayload.currentState.seq,
          ordinaryOnePayload.currentState.seq + 1,
          ordinaryOnePayload.currentState.seq + 2,
        ])
        expect(
          stores.inputQueueStore
            .listForSession(sessionRef.scopeRef, sessionRef.laneRef)
            .map((item) => item.seq)
        ).toEqual([
          ordinaryOnePayload.currentState.seq,
          ordinaryTwoPayload.currentState.seq,
          ordinaryThreePayload.currentState.seq,
        ])
        expect(contributionCalls).toHaveLength(1)
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, {
              status: 'running',
              hrcRunId: 'hrc-mixed-fifo',
              hostSessionId: 'hsid-mixed-fifo',
              generation: 5,
              runtimeId: 'rt-mixed-fifo',
            })
          }
          return { runId: 'hrc-mixed-fifo', sessionId: 'hsid-mixed-fifo' }
        },
        hrcClient: {
          submitActiveRunContribution: async (request: unknown) => {
            contributionCalls.push(request)
            const inputApplicationId = (request as { inputApplicationId: string })
              .inputApplicationId
            return {
              status: 'accepted',
              inputApplicationId,
              hostSessionId: 'hsid-mixed-fifo',
              generation: 5,
              runtimeId: 'rt-mixed-fifo',
              runId: 'hrc-mixed-fifo',
              capability: {
                supported: true,
                deliverySemantics: 'sequential_followup',
                ackSemantics: 'accepted_only',
                ordering: 'fifo',
                supportsAttachments: false,
              },
            }
          },
        } as never,
      }
    )
  })

  test('ordinary busy input still defaults to queued_run FIFO without contribution intent', async () => {
    const stores = createAdmissionStores()

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-busy-default:role:implementer`,
          laneRef: 'main',
        }

        await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'busy-default-active',
            sessionRef,
            content: 'start active run',
          },
        })
        const firstBusy = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'ordinary-queue-one',
            sessionRef,
            content: 'ordinary busy one',
          },
        })
        const secondBusy = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'ordinary-queue-two',
            sessionRef,
            content: 'ordinary busy two',
          },
        })

        const firstPayload = await fixture.json<{
          admission: { kind: string }
          currentState: { seq: number }
        }>(firstBusy)
        const secondPayload = await fixture.json<{
          admission: { kind: string }
          currentState: { seq: number }
        }>(secondBusy)

        expect(firstPayload.admission.kind).toBe('queued_run')
        expect(secondPayload.admission.kind).toBe('queued_run')
        expect(secondPayload.currentState.seq).toBe(firstPayload.currentState.seq + 1)
        expect(
          stores.inputQueueStore
            .listForSession(sessionRef.scopeRef, sessionRef.laneRef)
            .map((item) => item.seq)
        ).toEqual([firstPayload.currentState.seq, secondPayload.currentState.seq])
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return { runId: input.acpRunId ?? 'hrc-busy-default', sessionId: 'hsid-busy-default' }
        },
      }
    )
  })

  test('ambiguous active-run contribution remains admission_pending and does not queue', async () => {
    const stores = createAdmissionStores()

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-ambiguous:role:implementer`,
          laneRef: 'main',
        }

        await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'ambiguous-first',
            sessionRef,
            content: 'start active run',
          },
        })

        const contribution = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'ambiguous-second',
            sessionRef,
            content: 'maybe delivered',
            intent: { kind: 'contribute_to_active_run', fallback: 'queue' },
          },
        })
        const payload = await fixture.json<{
          targetRun: { runId: string; status: string }
          inputApplication: { status: string }
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; reason: string }
        }>(contribution)

        expect(contribution.status).toBe(201)
        expect(payload.admission.kind).toBe('admission_pending')
        expect(payload.inputApplication.status).toBe('ambiguous')
        expect(payload.currentState).toEqual(
          expect.objectContaining({
            applicationStatus: 'ambiguous',
            reason: 'delivery_ambiguous',
          })
        )
        expect(
          stores.inputQueueStore.listForSession(sessionRef.scopeRef, sessionRef.laneRef)
        ).toEqual([])
        expect(
          stores.adminStore.systemEvents
            .list({ projectId: fixture.seed.projectId })
            .map((event) => event.kind)
        ).toContain('input.application.pending')
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, {
              status: 'running',
              hrcRunId: 'hrc-ambiguous',
              hostSessionId: 'hsid-ambiguous',
            })
          }
          return { runId: 'hrc-ambiguous', sessionId: 'hsid-ambiguous' }
        },
        hrcClient: {
          submitActiveRunContribution: async () => {
            throw new Error('timeout waiting for active-run contribution')
          },
        } as never,
      }
    )
  })

  test('transport-error active-run contribution remains admission_pending and replays without queue fallback', async () => {
    const stores = createAdmissionStores()
    let contributionCalls = 0

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-transport-pending:role:implementer`,
          laneRef: 'main',
        }

        await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'transport-pending-first',
            sessionRef,
            content: 'start active run',
          },
        })

        const contributionBody = {
          idempotencyKey: 'transport-pending-second',
          sessionRef,
          content: 'recover this later',
          intent: { kind: 'contribute_to_active_run', fallback: 'pending_only' },
        }
        const contribution = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: contributionBody,
        })
        const replay = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: contributionBody,
        })
        const payload = await fixture.json<{
          inputAttempt: { inputAttemptId: string }
          targetRun: { runId: string; status: string }
          inputApplication: { inputApplicationId: string; status: string }
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; reason: string }
        }>(contribution)
        const replayPayload = await fixture.json<{
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; reason: string }
        }>(replay)
        const attempt = await fixture.request({
          method: 'GET',
          path: `/v1/input-attempts/${payload.inputAttempt.inputAttemptId}`,
        })
        const attemptPayload = await fixture.json<{
          admission: { kind: string; inputApplicationId: string }
          currentState: { applicationStatus: string; reason: string }
        }>(attempt)

        expect(contribution.status).toBe(201)
        expect(replay.status).toBe(200)
        expect(attempt.status).toBe(200)
        expect(payload.admission.kind).toBe('admission_pending')
        expect(payload.inputApplication.status).toBe('pending')
        expect(payload.currentState).toEqual(
          expect.objectContaining({
            applicationStatus: 'pending',
            reason: 'delivery_transport_error',
          })
        )
        expect(attemptPayload.admission).toEqual(payload.admission)
        expect(attemptPayload.currentState).toEqual(
          expect.objectContaining({
            applicationStatus: 'pending',
            reason: 'delivery_transport_error',
          })
        )
        expect(replayPayload.admission).toEqual(payload.admission)
        expect(replayPayload.currentState).toEqual(payload.currentState)
        expect(
          stores.inputQueueStore.listForSession(sessionRef.scopeRef, sessionRef.laneRef)
        ).toEqual([])
        expect(contributionCalls).toBe(1)
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'compose', compose: [] },
          harness: { provider: 'openai', interactive: true },
        }),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, {
              status: 'running',
              hrcRunId: 'hrc-transport-pending',
              hostSessionId: 'hsid-transport-pending',
              generation: 7,
              runtimeId: 'rt-transport-pending',
            })
          }
          return { runId: 'hrc-transport-pending', sessionId: 'hsid-transport-pending' }
        },
        hrcClient: {
          submitActiveRunContribution: async () => {
            contributionCalls += 1
            const error: Error & { code?: string } = new Error('HRC transport unavailable')
            error.code = 'transport_error'
            throw error
          },
        } as never,
      }
    )
  })

  test('control intent interrupts the active runtime without creating queued work', async () => {
    const stores = createAdmissionStores()
    const interrupts: string[] = []

    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-control:role:implementer`,
          laneRef: 'main',
        }

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'control-interrupt',
            sessionRef,
            content: 'interrupt',
            intent: { kind: 'control_active_run', action: 'interrupt' },
          },
        })
        const payload = await fixture.json<{
          admission: { kind: string }
          currentState: { controlStatus: string; action: string; runtimeId: string }
        }>(response)

        expect(response.status).toBe(201)
        expect(payload.admission.kind).toBe('accepted_in_flight')
        expect(payload.currentState).toEqual(
          expect.objectContaining({
            controlStatus: 'accepted',
            action: 'interrupt',
            runtimeId: 'rt-control',
          })
        )
        expect(interrupts).toEqual(['rt-control'])
        expect(fixture.runStore.listRuns()).toEqual([])
        expect(
          stores.inputQueueStore.listForSession(sessionRef.scopeRef, sessionRef.laneRef)
        ).toEqual([])
        expect(
          stores.adminStore.systemEvents
            .list({ projectId: fixture.seed.projectId })
            .map((event) => event.kind)
        ).toContain('input.application.accepted')
      },
      {
        ...stores,
        hrcClient: {
          resolveSession: async () => ({
            found: true,
            hostSessionId: 'hsid-control',
            generation: 4,
          }),
          listRuntimes: async () => [
            {
              runtimeId: 'rt-control',
              hostSessionId: 'hsid-control',
              generation: 4,
              status: 'ready',
              transport: 'tmux',
            },
          ],
          interrupt: async (runtimeId: string) => {
            interrupts.push(runtimeId)
            return { ok: true }
          },
        } as never,
      }
    )
  })
})
