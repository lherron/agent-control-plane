import { describe, expect, test } from 'bun:test'

import { appendEvent, cancelWake } from 'coordination-substrate'

import type { CoordinationStore, WakeRequest } from 'coordination-substrate'
import type { AcpServerDeps, InMemoryInputAttemptStore, InMemoryRunStore } from '../src/index.js'

import { withWiredServer } from './fixtures/wired-server.js'

type LaunchCall = Parameters<NonNullable<AcpServerDeps['launchRoleScopedRun']>>[0]

type WakeDispatcher = {
  start(input: { intervalMs: number }): void | Promise<void>
  stop(): Promise<void>
  runOnce(): Promise<void>
}

type WakeDispatcherFactoryInput = {
  coordStore: CoordinationStore
  inputAttemptStore: InMemoryInputAttemptStore
  runStore: InMemoryRunStore
  runtimeResolver: NonNullable<AcpServerDeps['runtimeResolver']>
  launchRoleScopedRun: NonNullable<AcpServerDeps['launchRoleScopedRun']>
}

type WakeDispatcherModule = {
  createWakeDispatcher(input: WakeDispatcherFactoryInput): WakeDispatcher
}

type Deferred<T> = {
  promise: Promise<T>
  resolve(value: T | PromiseLike<T>): void
  reject(reason?: unknown): void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function loadWakeDispatcherModule(): Promise<WakeDispatcherModule> {
  return (await import('../src/integration/wake-dispatcher.js')) as WakeDispatcherModule
}

function createRuntimeResolver(): NonNullable<AcpServerDeps['runtimeResolver']> {
  return async () => ({
    agentRoot: '/tmp/agents/curly',
    projectRoot: '/tmp/project',
    cwd: '/tmp/project',
    runMode: 'task',
    bundle: { kind: 'agent-default' },
    harness: { provider: 'openai', interactive: true },
  })
}

function createWakeDispatcherInput(input: {
  fixture: Awaited<Parameters<Parameters<typeof withWiredServer>[0]>[0]>
  launchRoleScopedRun: NonNullable<AcpServerDeps['launchRoleScopedRun']>
}): WakeDispatcherFactoryInput {
  return {
    coordStore: input.fixture.coordStore,
    inputAttemptStore: input.fixture.inputAttemptStore,
    runStore: input.fixture.runStore,
    runtimeResolver: createRuntimeResolver(),
    launchRoleScopedRun: input.launchRoleScopedRun,
  }
}

function seedWake(input: {
  coordStore: CoordinationStore
  projectId: string
  taskId: string
  agentId?: string | undefined
  dedupeKey?: string | undefined
}): { wake: WakeRequest; sessionRef: { scopeRef: string; laneRef: string } } {
  const sessionRef = {
    scopeRef: `agent:${input.agentId ?? 'curly'}:project:${input.projectId}:task:${input.taskId}:role:tester`,
    laneRef: 'main',
  } as const
  const appended = appendEvent(input.coordStore, {
    projectId: input.projectId,
    event: {
      ts: '2026-04-23T03:00:00.000Z',
      kind: 'handoff.declared',
      links: { taskId: input.taskId },
    },
    wake: {
      sessionRef,
      reason: 'wake dispatcher test',
      ...(input.dedupeKey !== undefined ? { dedupeKey: input.dedupeKey } : {}),
    },
  })

  if (appended.wake === undefined) {
    throw new Error('expected wake to be appended')
  }

  return { wake: appended.wake, sessionRef }
}

function readWakeState(coordStore: CoordinationStore, wakeId: string): string | undefined {
  const row = coordStore.sqlite
    .query<{ state: string }, [string]>('SELECT state FROM wake_requests WHERE wake_id = ?')
    .get(wakeId)

  return row?.state
}

describe('wake dispatcher worker', () => {
  test('leases pending wakes, creates an input attempt + run, dispatches through the shared launcher path, and consumes the wake', async () => {
    const launchCalls: LaunchCall[] = []
    const module = await loadWakeDispatcherModule()

    await withWiredServer(async (fixture) => {
      const { wake, sessionRef } = seedWake({
        coordStore: fixture.coordStore,
        projectId: fixture.seed.projectId,
        taskId: 'T-62001',
        dedupeKey: 'wake-dispatch-1',
      })
      const dispatcher = module.createWakeDispatcher(
        createWakeDispatcherInput({
          fixture,
          launchRoleScopedRun: async (call) => {
            launchCalls.push(call)
            return {
              runId: call.acpRunId ?? 'run-launch-fallback',
              sessionId: 'session-launch-001',
            }
          },
        })
      )

      await dispatcher.runOnce()

      const [storedRun] = fixture.runStore.listRuns()

      expect(storedRun).toMatchObject({
        scopeRef: sessionRef.scopeRef,
        laneRef: sessionRef.laneRef,
        taskId: 'T-62001',
      })
      expect(launchCalls).toHaveLength(1)
      expect(launchCalls[0]).toEqual(
        expect.objectContaining({
          sessionRef,
          acpRunId: storedRun?.runId,
          inputAttemptId: expect.any(String),
          runStore: fixture.runStore,
        })
      )
      expect(readWakeState(fixture.coordStore, wake.wakeId)).toBe('consumed')
    })
  })

  test('does not double-dispatch a leased wake when the first pass crashes after launch and before consume', async () => {
    const launchCalls: LaunchCall[] = []
    const module = await loadWakeDispatcherModule()

    await withWiredServer(async (fixture) => {
      const { wake } = seedWake({
        coordStore: fixture.coordStore,
        projectId: fixture.seed.projectId,
        taskId: 'T-62002',
        dedupeKey: 'wake-dispatch-2',
      })
      const dispatcher = module.createWakeDispatcher(
        createWakeDispatcherInput({
          fixture,
          launchRoleScopedRun: async (call) => {
            launchCalls.push(call)
            const error = new Error('dispatch crashed after launch') as Error & {
              code?: string | undefined
            }
            error.code = 'runtime_unavailable'
            throw error
          },
        })
      )

      await dispatcher.runOnce()
      await dispatcher.runOnce()

      const [storedRun] = fixture.runStore.listRuns()

      expect(launchCalls).toHaveLength(1)
      expect(fixture.runStore.listRuns()).toHaveLength(1)
      expect(storedRun?.errorCode).toBe('runtime_unavailable')
      expect(readWakeState(fixture.coordStore, wake.wakeId)).not.toBe('consumed')
    })
  })

  test('skips cancelled wakes', async () => {
    const launchCalls: LaunchCall[] = []
    const module = await loadWakeDispatcherModule()

    await withWiredServer(async (fixture) => {
      const { wake } = seedWake({
        coordStore: fixture.coordStore,
        projectId: fixture.seed.projectId,
        taskId: 'T-62003',
      })
      cancelWake(fixture.coordStore, { wakeId: wake.wakeId })
      const dispatcher = module.createWakeDispatcher(
        createWakeDispatcherInput({
          fixture,
          launchRoleScopedRun: async (call) => {
            launchCalls.push(call)
            return {
              runId: call.acpRunId ?? 'run-launch-fallback',
              sessionId: 'session-launch-001',
            }
          },
        })
      )

      await dispatcher.runOnce()

      expect(launchCalls).toHaveLength(0)
      expect(fixture.runStore.listRuns()).toHaveLength(0)
      expect(readWakeState(fixture.coordStore, wake.wakeId)).toBe('cancelled')
    })
  })

  test('shuts down cleanly when stop() is called during an in-flight poll', async () => {
    const launchCalls: LaunchCall[] = []
    const launchStarted = createDeferred<void>()
    const releaseLaunch = createDeferred<void>()
    const module = await loadWakeDispatcherModule()

    await withWiredServer(async (fixture) => {
      seedWake({
        coordStore: fixture.coordStore,
        projectId: fixture.seed.projectId,
        taskId: 'T-62004',
      })
      const dispatcher = module.createWakeDispatcher(
        createWakeDispatcherInput({
          fixture,
          launchRoleScopedRun: async (call) => {
            launchCalls.push(call)
            launchStarted.resolve()
            await releaseLaunch.promise
            return {
              runId: call.acpRunId ?? 'run-launch-fallback',
              sessionId: 'session-launch-001',
            }
          },
        })
      )

      await dispatcher.start({ intervalMs: 1 })
      await Promise.race([
        launchStarted.promise,
        Bun.sleep(250).then(() => {
          throw new Error('wake dispatcher did not start polling')
        }),
      ])

      const stopPromise = dispatcher.stop()
      let stopped = false
      void stopPromise.then(() => {
        stopped = true
      })

      await Bun.sleep(25)
      expect(stopped).toBe(false)

      releaseLaunch.resolve()
      await stopPromise
      await Bun.sleep(25)

      expect(launchCalls).toHaveLength(1)
    })
  })
})
