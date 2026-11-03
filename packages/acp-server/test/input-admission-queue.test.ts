import { describe, expect, test } from 'bun:test'
import { createInMemoryAdminStore } from 'acp-admin-store'
import { openAcpStateStore } from 'acp-state-store'

import { createInputQueueDispatcher } from '../src/integration/input-queue-dispatcher.js'

import {
  type LaunchCall,
  admissionRuntime,
  createAdmissionStores,
} from './fixtures/input-admission.js'
import { withWiredServer } from './fixtures/wired-server.js'

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
        const firstPayload = await fixture.json<{
          run: { runId: string; status: string }
        }>(first)
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
          launchRoleScopedRun: async (input) => {
            launchCalls.push(input)
            if (input.acpRunId !== undefined) {
              input.runStore?.updateRun(input.acpRunId, { status: 'running' })
            }
            return {
              runId: input.acpRunId ?? 'run-fallback',
              sessionId: 'session-queue',
            }
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
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          launchCalls.push(input)
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return {
            runId: input.acpRunId ?? 'run-fallback',
            sessionId: 'session-first',
          }
        },
      }
    )
  })

  test('SQLite-backed queued admission dispatches without lifecycle status constraint errors', async () => {
    const stateStore = openAcpStateStore({ dbPath: ':memory:' })
    const adminStore = createInMemoryAdminStore()
    const launchCalls: LaunchCall[] = []

    try {
      const sessionRef = {
        scopeRef: 'agent:larry:project:test:task:T-sqlite-queue:role:implementer',
        laneRef: 'main',
      }
      const run = stateStore.runs.createRun({
        sessionRef,
        actor: { kind: 'agent', id: 'larry' },
        status: 'queued',
        metadata: { content: 'queued input' },
      })
      const attempt = stateStore.inputAttempts.createAttempt({
        sessionRef,
        idempotencyKey: 'sqlite-queue-second',
        content: 'queued input',
        actor: { kind: 'agent', id: 'larry' },
        associatedRunId: run.runId,
      })
      const queueItem = stateStore.inputQueue.create({
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        runId: run.runId,
        scopeRef: sessionRef.scopeRef,
        laneRef: sessionRef.laneRef,
        seq: 1,
      })
      stateStore.inputAdmissions.create({
        inputAttemptId: attempt.inputAttempt.inputAttemptId,
        admissionKind: 'queued_run',
        intent: { kind: 'new_work' },
        originalResponse: {
          kind: 'queued_run',
          inputAttemptId: attempt.inputAttempt.inputAttemptId,
          runId: run.runId,
          queueItemId: queueItem.queueItemId,
        },
        currentState: { queueStatus: 'queued', seq: queueItem.seq },
        runId: run.runId,
        queueItemId: queueItem.queueItemId,
        status: 'queued',
      })

      const dispatcher = createInputQueueDispatcher({
        adminStore,
        hrcClient: undefined,
        inputAdmissionStore: stateStore.inputAdmissions,
        inputQueueStore: stateStore.inputQueue,
        runStore: stateStore.runs,
        runtimeResolver: async () => admissionRuntime(),
        launchRoleScopedRun: async (input) => {
          launchCalls.push(input)
          if (input.acpRunId !== undefined) {
            input.runStore?.updateRun(input.acpRunId, { status: 'running' })
          }
          return {
            runId: input.acpRunId ?? 'run-sqlite-queue',
            sessionId: 'session-sqlite-queue',
          }
        },
        inputQueuePolicy: {},
        config: { intervalMs: 60_000 },
      })

      await dispatcher.runOnce()

      expect(launchCalls).toHaveLength(1)
      expect(launchCalls[0]?.acpRunId).toBe(run.runId)
      expect(stateStore.runs.getRun(run.runId)?.status).toBe('running')
      expect(stateStore.inputQueue.getById(queueItem.queueItemId)?.status).toBe('running')
      const admission = stateStore.inputAdmissions.getByInputAttemptId(
        attempt.inputAttempt.inputAttemptId
      )
      expect(admission?.status).toBe('started')
      expect(admission?.currentState?.['queueStatus']).toBe('running')
      expect(admission?.currentState?.['runStatus']).toBe('running')
    } finally {
      stateStore.close()
    }
  })
})
