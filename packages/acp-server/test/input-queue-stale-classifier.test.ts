import { describe, expect, test } from 'bun:test'
import { createInMemoryAdminStore } from 'acp-admin-store'
import type { InputQueueItem } from 'acp-core'

import {
  InMemoryInputAdmissionStore,
  InMemoryInputQueueStore,
  InMemoryRunStore,
  type StoredRun,
} from '../src/index.js'
import * as inputQueueDispatcherModule from '../src/integration/input-queue-dispatcher.js'
import { createInputQueueDispatcher } from '../src/integration/input-queue-dispatcher.js'
import { LAUNCH_CORRELATION_WINDOW_MS } from '../src/real-launcher.js'

type DispatcherDeps = Parameters<typeof createInputQueueDispatcher>[0]
type DispatcherTestHooks = {
  classifyStalePendingRunBlocker: (input: {
    run: StoredRun
    siblings: readonly StoredRun[]
    timeoutMs: number
    hrcDbPath?: string | undefined
    hasHrcAcceptedRunSince?: (
      hrcDbPath: string,
      hostSessionId: string,
      since: string,
      until?: string
    ) => boolean
  }) => 'no_correlation' | 'partial_correlation' | undefined
  sameSessionHasActiveRun: (deps: DispatcherDeps, item: InputQueueItem) => boolean
}

function createDeps(
  overrides: Partial<DispatcherDeps> & {
    hrcDbPath?: string | undefined
    hasHrcAcceptedRunSince?: (
      hrcDbPath: string,
      hostSessionId: string,
      since: string,
      until?: string
    ) => boolean
  } = {}
): DispatcherDeps {
  const deps = {
    adminStore: createInMemoryAdminStore(),
    hrcClient: undefined,
    inputAdmissionStore: new InMemoryInputAdmissionStore(),
    inputQueueStore: new InMemoryInputQueueStore(),
    runStore: new InMemoryRunStore(),
    runtimeResolver: async () => ({
      agentRoot: '/tmp/agents/larry',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task' as const,
      bundle: { kind: 'compose' as const, compose: [] },
      harness: { provider: 'openai' as const, interactive: true },
    }),
    launchRoleScopedRun: async () => {
      throw new Error('launchRoleScopedRun should not be called by stale-classifier tests')
    },
    inputQueuePolicy: {},
    config: { intervalMs: 60_000, stalePendingRunTimeoutMs: 1 },
    ...overrides,
  }
  return deps as DispatcherDeps
}

function createQueuedItem(
  deps: DispatcherDeps,
  input: { run: StoredRun; seq?: number | undefined }
): InputQueueItem {
  return deps.inputQueueStore.create({
    inputAttemptId: `attempt-${input.run.runId}`,
    runId: input.run.runId,
    scopeRef: input.run.scopeRef,
    laneRef: input.run.laneRef,
    seq: input.seq ?? 1,
  })
}

async function letRunBecomeStale(): Promise<void> {
  await Bun.sleep(2)
}

function testingHooks(): DispatcherTestHooks {
  const candidate = inputQueueDispatcherModule as typeof inputQueueDispatcherModule & {
    __testing?: DispatcherTestHooks
  }
  expect(candidate.__testing).toBeDefined()
  return candidate.__testing as DispatcherTestHooks
}

describe('input queue stale pending classifier', () => {
  test('R1 parked partial-correlation run is protected by an active running sibling', async () => {
    const deps = createDeps()
    const sessionRef = {
      scopeRef: 'agent:larry:project:agent-spaces:task:T-r1:role:implementer',
      laneRef: 'main',
    }
    const parked = deps.runStore.createRun({ sessionRef, status: 'pending' })
    deps.runStore.updateRun(parked.runId, { hostSessionId: 'hsid-r1-parked' })
    const active = deps.runStore.createRun({ sessionRef, status: 'running' })
    const queued = deps.runStore.createRun({ sessionRef, status: 'queued' })
    createQueuedItem(deps, { run: queued })

    await letRunBecomeStale()
    await createInputQueueDispatcher(deps).runOnce()

    expect(deps.runStore.getRun(parked.runId)).toMatchObject({
      status: 'pending',
      hostSessionId: 'hsid-r1-parked',
    })
    expect(deps.runStore.getRun(active.runId)?.status).toBe('running')
    expect(deps.runStore.getRun(queued.runId)?.status).toBe('queued')
  })

  test('R2 parked partial-correlation run in an idle session is failed after timeout', async () => {
    const deps = createDeps()
    const sessionRef = {
      scopeRef: 'agent:larry:project:agent-spaces:task:T-r2:role:implementer',
      laneRef: 'main',
    }
    const parked = deps.runStore.createRun({ sessionRef, status: 'pending' })
    deps.runStore.updateRun(parked.runId, { hostSessionId: 'hsid-r2-parked' })

    await letRunBecomeStale()
    await createInputQueueDispatcher(deps).runOnce()

    expect(deps.runStore.getRun(parked.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'dispatch_timeout',
    })
    expect(deps.runStore.getRun(parked.runId)?.errorMessage).toContain(
      'partial HRC session correlation'
    )
  })

  test('R3 sibling stuck pending without correlation does not protect another stale blocker', async () => {
    const deps = createDeps()
    const sessionRef = {
      scopeRef: 'agent:larry:project:agent-spaces:task:T-r3:role:implementer',
      laneRef: 'main',
    }
    const stuckWithoutCorrelation = deps.runStore.createRun({ sessionRef, status: 'pending' })
    const parked = deps.runStore.createRun({ sessionRef, status: 'pending' })
    deps.runStore.updateRun(parked.runId, { hostSessionId: 'hsid-r3-parked' })

    await letRunBecomeStale()
    await createInputQueueDispatcher(deps).runOnce()

    expect(deps.runStore.getRun(stuckWithoutCorrelation.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'dispatch_timeout',
    })
    expect(deps.runStore.getRun(parked.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'dispatch_timeout',
    })
  })

  test('R4 HRC accepted-run evidence protects a partial-correlation run without ACP siblings', async () => {
    const acceptedChecks: Array<{
      hrcDbPath: string
      hostSessionId: string
      since: string
      until?: string
    }> = []
    const deps = createDeps({
      hrcDbPath: '/tmp/hrc-r4.sqlite',
      hasHrcAcceptedRunSince: (hrcDbPath, hostSessionId, since, until) => {
        acceptedChecks.push({ hrcDbPath, hostSessionId, since, until })
        return true
      },
    })
    const sessionRef = {
      scopeRef: 'agent:larry:project:agent-spaces:task:T-r4:role:implementer',
      laneRef: 'main',
    }
    const parked = deps.runStore.createRun({ sessionRef, status: 'pending' })
    const partial = deps.runStore.updateRun(parked.runId, { hostSessionId: 'hsid-r4-parked' })

    await letRunBecomeStale()
    await createInputQueueDispatcher(deps).runOnce()

    // T-04297 follow-up: the launch-evidence query is now BOUNDED — the `until`
    // edge is createdAt + LAUNCH_CORRELATION_WINDOW_MS (5 min), so unrelated
    // later turns on the same host session cannot resurrect a dead pending run.
    expect(acceptedChecks).toEqual([
      {
        hrcDbPath: '/tmp/hrc-r4.sqlite',
        hostSessionId: 'hsid-r4-parked',
        since: partial.createdAt,
        until: new Date(Date.parse(partial.createdAt) + LAUNCH_CORRELATION_WINDOW_MS).toISOString(),
      },
    ])
    expect(deps.runStore.getRun(parked.runId)?.status).toBe('pending')
  })

  test('T-04297 unrelated later HRC run (outside the window) does NOT protect the blocker; queue unjams', async () => {
    // Simulate the real incident: a pending ACP run that never launched, with an
    // HRC run accepted on the same host session but FAR outside the correlation
    // window (the 15:03 failure vs. unrelated 17:18 turns). The bounded query
    // returns false for that out-of-window evidence, so the blocker is failed.
    const deps = createDeps({
      hrcDbPath: '/tmp/hrc-t04297.sqlite',
      hasHrcAcceptedRunSince: (_hrcDbPath, _hostSessionId, since, until) => {
        // Out-of-window evidence: an HRC run accepted 2h after `since`, i.e.
        // AFTER `until`. A correctly-bounded query finds nothing → returns false.
        const acceptedAtMs = Date.parse(since) + 2 * 60 * 60_000
        if (until === undefined) {
          return true
        }
        return acceptedAtMs < Date.parse(until)
      },
    })
    const sessionRef = {
      scopeRef: 'agent:mneme:project:media-ingest:task:primary',
      laneRef: 'main',
    }
    const blocker = deps.runStore.createRun({ sessionRef, status: 'pending' })
    deps.runStore.updateRun(blocker.runId, { hostSessionId: 'hsid-mneme-primary' })

    await letRunBecomeStale()
    await createInputQueueDispatcher(deps).runOnce()

    expect(deps.runStore.getRun(blocker.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'dispatch_timeout',
    })
  })

  test('R4 classifier returns undefined when HRC accepted-run evidence exists', async () => {
    const deps = createDeps()
    const sessionRef = {
      scopeRef: 'agent:larry:project:agent-spaces:task:T-r4-classifier:role:implementer',
      laneRef: 'main',
    }
    const parked = deps.runStore.createRun({ sessionRef, status: 'pending' })
    const partial = deps.runStore.updateRun(parked.runId, { hostSessionId: 'hsid-r4-classifier' })

    await letRunBecomeStale()

    expect(
      testingHooks().classifyStalePendingRunBlocker({
        run: deps.runStore.getRun(partial.runId) ?? partial,
        siblings: [],
        timeoutMs: 1,
        hrcDbPath: '/tmp/hrc-r4-classifier.sqlite',
        hasHrcAcceptedRunSince: () => true,
      })
    ).toBeUndefined()
  })

  test('R5 sameSessionHasActiveRun is pure across repeated calls', async () => {
    const deps = createDeps()
    const sessionRef = {
      scopeRef: 'agent:larry:project:agent-spaces:task:T-r5:role:implementer',
      laneRef: 'main',
    }
    const staleBlocker = deps.runStore.createRun({ sessionRef, status: 'pending' })
    deps.runStore.updateRun(staleBlocker.runId, { hostSessionId: 'hsid-r5-stale' })
    const queued = deps.runStore.createRun({ sessionRef, status: 'queued' })
    const item = createQueuedItem(deps, { run: queued })

    await letRunBecomeStale()
    const before = deps.runStore.listRuns()
    const hooks = testingHooks()
    const first = hooks.sameSessionHasActiveRun(deps, item)
    const second = hooks.sameSessionHasActiveRun(deps, item)
    const after = deps.runStore.listRuns()

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(after).toEqual(before)
  })

  test('R6 idle stale runs are eventually reaped by a separate bounded sweep pass', async () => {
    const deps = createDeps()
    const sessionRef = {
      scopeRef: 'agent:larry:project:agent-spaces:task:T-r6:role:implementer',
      laneRef: 'main',
    }
    const parked = deps.runStore.createRun({ sessionRef, status: 'pending' })
    deps.runStore.updateRun(parked.runId, { hostSessionId: 'hsid-r6-parked' })
    const dispatcher = createInputQueueDispatcher(deps)

    await letRunBecomeStale()
    for (let tick = 0; tick < 5; tick += 1) {
      await dispatcher.runOnce()
    }

    expect(deps.runStore.getRun(parked.runId)).toMatchObject({
      status: 'failed',
      errorCode: 'dispatch_timeout',
    })
  })
})
