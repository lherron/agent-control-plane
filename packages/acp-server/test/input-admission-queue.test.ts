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
            bundle: { kind: 'agent-default' },
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
          bundle: { kind: 'agent-default' },
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
          bundle: { kind: 'agent-default' },
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
            resolveSession: async () => ({ hostSessionId: 'hsid-pin', generation: 4 }),
          } as never,
          inputAdmissionStore: stores.inputAdmissionStore,
          inputQueueStore: stores.inputQueueStore,
          runStore: fixture.runStore,
          runtimeResolver: async () => ({
            agentRoot: '/tmp/agents/larry',
            projectRoot: '/tmp/project',
            cwd: '/tmp/project',
            runMode: 'task',
            bundle: { kind: 'agent-default' },
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
          bundle: { kind: 'agent-default' },
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
            bundle: { kind: 'agent-default' },
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
          bundle: { kind: 'agent-default' },
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

  test('explicit active-run contribution queues fallback when HRC rejects unsupported delivery', async () => {
    const stores = createAdmissionStores()
    const launchCalls: LaunchCall[] = []
    const contributionCalls: unknown[] = []

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
            reason: 'active_run_contribution_disabled',
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
      },
      {
        ...stores,
        runtimeResolver: async () => ({
          agentRoot: '/tmp/agents/larry',
          projectRoot: '/tmp/project',
          cwd: '/tmp/project',
          runMode: 'task',
          bundle: { kind: 'agent-default' },
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
              status: 'rejected',
              inputApplicationId,
              hostSessionId: 'hsid-active',
              generation: 3,
              runtimeId: 'rt-active',
              runId: 'hrc-active',
              capability: { supported: false },
              errorCode: 'active_run_contribution_disabled',
              errorMessage: 'disabled',
            }
          },
        } as never,
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
          bundle: { kind: 'agent-default' },
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
          resolveSession: async () => ({ hostSessionId: 'hsid-control', generation: 4 }),
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
