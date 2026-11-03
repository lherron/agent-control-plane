import { describe, expect, test } from 'bun:test'

import { createInputQueueDispatcher } from '../src/integration/input-queue-dispatcher.js'

import {
  type LaunchCall,
  admissionRuntime,
  createAdmissionStores,
} from './fixtures/input-admission.js'
import { withWiredServer } from './fixtures/wired-server.js'

describe('input dispatch fairness', () => {
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
          runtimeResolver: async () => admissionRuntime('bulk'),
          launchRoleScopedRun: async (input) => {
            if (input.acpRunId !== undefined) {
              launchedRunIds.push(input.acpRunId)
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return {
              runId: input.acpRunId ?? 'run-bulk',
              sessionId: 'session-bulk',
            }
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
        runtimeResolver: async () => admissionRuntime('bulk'),
        launchRoleScopedRun: async (input) => {
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return {
            runId: input.acpRunId ?? 'hrc-bulk-first',
            sessionId: 'hsid-bulk-first',
          }
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

          fixture.runStore.updateRun(a1Payload.run.runId, {
            status: 'completed',
          })
          fixture.runStore.updateRun(b1Payload.run.runId, {
            status: 'completed',
          })

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
              return admissionRuntime('bob')
            },
            launchRoleScopedRun: async (input) => {
              launchCalls.push(input)
              if (input.acpRunId !== undefined) {
                input.runStore?.updateRun(input.acpRunId, {
                  status: 'running',
                })
              }
              return {
                runId: input.acpRunId ?? 'run-throw',
                sessionId: 'session-throw',
              }
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
            line.includes('"event":"input_queue.dispatch_failed"')
          )
          expect(dispatcherErrors.length).toBeGreaterThan(0)
          expect(dispatcherErrors[0]).toContain(a2Payload.admission.queueItemId)
          expect(dispatcherErrors[0]).toContain('boom: simulated runtimeResolver failure')
        },
        {
          ...stores,
          runtimeResolver: async () => admissionRuntime('alice'),
          launchRoleScopedRun: async (input) => {
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return {
              runId: input.acpRunId ?? 'hrc-throw-first',
              sessionId: 'hsid-throw-first',
            }
          },
        }
      )
    } finally {
      console.error = originalConsoleError
    }
  })
})
