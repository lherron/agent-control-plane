import { describe, expect, test } from 'bun:test'

import { createInputQueueDispatcher } from '../src/integration/input-queue-dispatcher.js'

import {
  type LaunchCall,
  admissionRuntime,
  createAdmissionStores,
} from './fixtures/input-admission.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('input queue policy', () => {
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
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return {
            runId: input.acpRunId ?? 'run-fallback',
            sessionId: 'session-depth',
          }
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

        fixture.runStore.updateRun(firstPayload.run.runId, {
          status: 'completed',
        })
        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: {
            resolveSession: async () => ({
              found: true,
              hostSessionId: 'hsid-pin',
              generation: 4,
            }),
          } as never,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => admissionRuntime(),
          inputQueuePolicy: {},
          launchRoleScopedRun: async (input) => {
            launchCalls.push(input)
            return {
              runId: input.acpRunId ?? 'run-fallback',
              sessionId: 'session-pin',
            }
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
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          launchCalls.push(input)
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, {
              status: 'running',
              hostSessionId: 'hsid-pin',
              generation: 3,
            })
          }
          return {
            runId: input.acpRunId ?? 'run-fallback',
            sessionId: 'session-pin',
          }
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
        fixture.runStore.updateRun(firstPayload.run.runId, {
          status: 'completed',
        })
        const dispatcher = createInputQueueDispatcher({
          adminStore: stores.adminStore,
          hrcClient: undefined,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => admissionRuntime(),
          inputQueuePolicy: { ttlMs: 1 },
          launchRoleScopedRun: async (input) => {
            launchCalls.push(input)
            return {
              runId: input.acpRunId ?? 'run-fallback',
              sessionId: 'session-ttl',
            }
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
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          launchCalls.push(input)
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return {
            runId: input.acpRunId ?? 'run-fallback',
            sessionId: 'session-ttl',
          }
        },
      }
    )
  })
})
