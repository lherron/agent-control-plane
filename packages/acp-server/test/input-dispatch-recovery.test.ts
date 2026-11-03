import { describe, expect, test } from 'bun:test'

import { createInputQueueDispatcher } from '../src/integration/input-queue-dispatcher.js'

import {
  type LaunchCall,
  admissionRuntime,
  createAdmissionStores,
} from './fixtures/input-admission.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('input dispatch recovery', () => {
  test('T-04935 inline launch failure marks the run failed instead of leaving it pending', async () => {
    // The inline path creates the run `pending` (no queue item) before awaiting
    // the launch. A non-runtime-busy launch error must transition the run to
    // `failed` — leaving it `pending` makes it a phantom that jams every later
    // dispatch in the lane via sameSessionHasActiveRun.
    const launchCalls: LaunchCall[] = []
    await withWiredServer(
      async (fixture) => {
        const sessionRef = {
          scopeRef: `agent:larry:project:${fixture.seed.projectId}:task:T-inline-fail:role:implementer`,
          laneRef: 'main',
        }

        const response = await fixture.request({
          method: 'POST',
          path: '/v1/inputs',
          body: {
            idempotencyKey: 'inline-fail-first',
            sessionRef,
            content: 'inline launch that throws',
          },
        })
        // handleCreateInput re-throws the launch error after failing the run.
        expect(response.status).toBe(500)
        expect(launchCalls).toHaveLength(1)

        const runs = fixture.runStore
          .listRuns()
          .filter((run) => run.scopeRef === sessionRef.scopeRef)
        expect(runs).toHaveLength(1)
        expect(runs[0]).toMatchObject({
          status: 'failed',
          errorCode: 'launch_failed',
        })
        // No phantom pending run remains to block the lane.
        expect(runs.filter((run) => run.status === 'pending')).toHaveLength(0)
      },
      {
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          launchCalls.push(input)
          // Run stays `pending` (launcher threw before writing hrcRunId/status).
          throw new Error('simulated HRC dispatch failure')
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
        const firstPayload = await fixture.json<{
          run: { runId: string; status: string }
        }>(first)
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
          runtimeResolver: async () => admissionRuntime(),
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
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          initialLaunchCalls.push(input)
          return {
            runId: 'hrc-stale-pending-first',
            sessionId: 'session-stale-pending-first',
          }
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

        fixture.runStore.updateRun(firstPayload.run.runId, {
          status: 'completed',
        })
        fixture.runStore.updateRun(secondPayload.run.runId, {
          status: 'completed',
        })
        stores.inputQueueStore.update(secondPayload.admission.queueItemId, {
          status: 'dispatching',
        })

        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => admissionRuntime(),
          launchRoleScopedRun: async (input) => {
            queuedLaunchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return {
              runId: input.acpRunId ?? 'run-fallback',
              sessionId: 'session-terminal-head',
            }
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
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return {
            runId: input.acpRunId ?? 'hrc-terminal-head',
            sessionId: 'hsid-terminal-head',
          }
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
        const firstPayload = await fixture.json<{
          run: { runId: string; status: string }
        }>(first)
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
          runtimeResolver: async () => admissionRuntime(),
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
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          initialLaunchCalls.push(input)
          return {
            runId: 'hrc-partial-corr-first',
            sessionId: 'hsid-partial-corr-first',
          }
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
        fixture.runStore.updateRun(firstPayload.run.runId, {
          status: 'completed',
        })

        // Simulate a wedged dispatcher: queued head was leased but never reached terminal state.
        // Leave the run in a non-terminal state to verify the lease-timeout path fails it.
        const oldLease = new Date(Date.now() - 60_000).toISOString()
        stores.inputQueueStore.update(secondPayload.admission.queueItemId, {
          status: 'dispatching',
          leasedAt: oldLease,
          leaseOwner: 'wedged-dispatcher',
        })
        fixture.runStore.updateRun(secondPayload.run.runId, {
          status: 'pending',
        })

        await Bun.sleep(2)
        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => admissionRuntime(),
          launchRoleScopedRun: async (input) => {
            queuedLaunchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return {
              runId: input.acpRunId ?? 'run-lease',
              sessionId: 'session-lease',
            }
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
        const events = stores.adminStore.systemEvents.list({
          projectId: fixture.seed.projectId,
        })
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
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return {
            runId: input.acpRunId ?? 'hrc-lease-first',
            sessionId: 'hsid-lease-first',
          }
        },
      }
    )
  })
})
