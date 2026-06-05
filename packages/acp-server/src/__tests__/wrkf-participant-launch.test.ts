/**
 * RED TESTS — W4b: participant-launch service (T-01934)
 *
 * All tests in this file fail at module-load time because
 * packages/acp-server/src/wrkf/participant-launch.ts does not exist yet.
 * Bun throws CannotFindModule at the import below → every test is RED.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT — what must be created to go green:
 *
 * File: packages/acp-server/src/wrkf/participant-launch.ts
 *
 *   export type WrkfParticipantLaunchInput = {
 *     taskId: string
 *     role: string
 *     actor?: Actor | undefined
 *     idempotencyKey: string
 *     sessionRef: SessionRef
 *     initialPrompt?: string | undefined
 *   }
 *
 *   export type WrkfParticipantLaunchDeps = {
 *     wrkf: AcpWrkfWorkflowPort
 *     runStore: RunStore
 *     launchRoleScopedRun: LaunchRoleScopedRun
 *     runtimeResolver?: RuntimeResolver | undefined
 *     agentRootResolver?: AgentRootResolver | undefined
 *     adminStore?: AdminStore | undefined
 *   }
 *
 *   export type WrkfLaunchInfo = {
 *     runId: string
 *     hostSessionId?: string | undefined
 *     runtimeId?: string | undefined
 *     launchId?: string | undefined
 *     generation?: number | undefined
 *   }
 *
 *   export type WrkfParticipantLaunchResult = {
 *     source: 'wrkf'
 *     taskId: string
 *     instanceId: string
 *     workflowRef: string
 *     revision: number
 *     contextHash?: string | undefined
 *     wrkfRun: Record<string, unknown>
 *     launch?: WrkfLaunchInfo | undefined
 *     replay: boolean
 *   }
 *
 *   export async function launchParticipant(
 *     deps: WrkfParticipantLaunchDeps,
 *     input: WrkfParticipantLaunchInput,
 *   ): Promise<WrkfParticipantLaunchResult>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SERVICE SEQUENCE:
 *   1. wrkf.task.inspect({task: taskId}) → {task, instance}
 *   2. wrkf.next({task: taskId})
 *   3. wrkf.run.start({task: taskId, role, actor, idempotencyKey}) → wrkfRun
 *   4. if (wrkfRun.externalRunRef !== undefined) → replay path:
 *        return {source:'wrkf', ..., replay:true, launch:undefined}
 *   5. createOrGetRun({wrkfRunId: wrkfRun.id, ...}) → {run: acpRun, created}
 *   6a. if (!created && acpRun.hrcRunId !== undefined):
 *         // crash-window recovery: HRC ref already discovered by prior attempt
 *         wrkf.run.bindExternal({
 *           runId: wrkfRun.id,
 *           externalRunRef: acpRun.hrcRunId,
 *           deliveryRef: stableJson({kind:'hrc', ...}),
 *           idempotencyKey: `${idempotencyKey}:bindExternal`,
 *         })
 *         return {source:'wrkf', ..., replay:false, launch:undefined}
 *   6b. else (fresh start or prior attempt never launched):
 *         prompt  = buildParticipantPrompt({task, instance, next, ...})
 *         intent  = resolveLaunchIntent(deps, sessionRef, {initialPrompt: prompt})
 *         launched = await launchRoleScopedRun({sessionRef, intent, acpRunId: acpRun.runId})
 *         // Record HRC runId BEFORE bindExternal so crash-window recovery can find it:
 *         runStore.updateRun(acpRun.runId, {hrcRunId: launched.runId, ...})
 *         wrkf.run.bindExternal({
 *           runId: wrkfRun.id,
 *           externalRunRef: launched.runId,
 *           deliveryRef: stableJson({kind:'hrc', hostSessionId, runtimeId, launchId, scopeRef, laneRef, generation}),
 *           idempotencyKey: `${idempotencyKey}:bindExternal`,
 *         })
 *         return {source:'wrkf', ..., wrkfRun, launch: launched, replay:false}
 *
 * CRITICAL INVARIANT: runStore.updateRun({hrcRunId}) MUST be called BEFORE wrkf.run.bindExternal.
 * This ensures the ACP run carries the discovered HRC ref for crash-window recovery, even if
 * bindExternal fails.
 *
 * stableJson: deterministic JSON serialization (sorted keys) so deliveryRef is reproducible.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CRASH-WINDOW RECOVERY (daedalus risk #1):
 *
 *   Scenario: first attempt launched HRC successfully (acpRun.hrcRunId recorded) but
 *   crashed before wrkf.run.bindExternal completed.
 *
 *   On retry (same idempotencyKey):
 *   - wrkf.run.start → same wrkfRun (no externalRunRef, idempotent from wrkf)
 *   - createOrGetRun → {run: existingAcpRun, created: false}
 *   - existingAcpRun.hrcRunId is set → skip relaunch, bind discovered ref
 *   - wrkf.run.bindExternal is the final arbiter (rejects conflicting refs)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

// RED IMPORT — participant-launch.ts does not exist yet (W4b deliverable).
// Bun throws CannotFindModule at this line → all tests in this file are RED.
// @ts-expect-error -- participant-launch.ts is the W4b deliverable; does not exist yet
import { launchParticipant } from '../wrkf/participant-launch.js'

import type { LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
import { InMemoryRunStore } from '../domain/run-store.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Local type aliases matching the service contract ───────────────────────
type LaunchResult = {
  source: 'wrkf'
  taskId: string
  instanceId: string
  workflowRef: string
  revision: number
  contextHash?: string | undefined
  wrkfRun: Record<string, unknown>
  launch?: {
    runId: string
    hostSessionId?: string
    runtimeId?: string
    launchId?: string
    generation?: number
  }
  replay: boolean
}

// ─── Shared fixture data ─────────────────────────────────────────────────────

const TASK_ID = 'T-09991'
const ROLE = 'implementer'
const IDEMPOTENCY_KEY = 'wrkf-launch-test-001'
const SESSION_REF = { scopeRef: 'agent:larry:project:acps-test:task:T-09991', laneRef: 'main' }

const CANNED_TASK = { taskId: TASK_ID, projectId: 'P-001', status: 'open', version: 3 }
const CANNED_INSTANCE = {
  instanceId: 'inst-aaa111',
  workflowRef: 'canonical-flow@v1',
  revision: 5,
  phase: 'in_progress',
}
const CANNED_NEXT = { transitions: [{ id: 'complete', label: 'Complete' }] }

/** wrkfRun returned by run.start when no externalRunRef is bound yet */
const CANNED_WRKF_RUN = {
  id: 'wrkfrun-bbb222',
  taskId: TASK_ID,
  role: ROLE,
  state: 'active',
  // externalRunRef: undefined  ← not set; this is the pre-bind state
}

/** wrkfRun returned by run.start when externalRunRef is already bound (replay scenario) */
const CANNED_WRKF_RUN_BOUND = {
  ...CANNED_WRKF_RUN,
  externalRunRef: 'hrc-run-already-launched-001',
}

/** Successful HRC launch result */
const CANNED_LAUNCHED = {
  runId: 'hrc-run-launched-001',
  sessionId: 'host-session-001',
  hostSessionId: 'host-session-001',
  runtimeId: 'runtime-001',
  launchId: 'launch-001',
  generation: 3,
}

/** Typed wrkf error for testing error propagation */
class WrkfError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WrkfError'
  }
}

// ─── Fake dependency builders ────────────────────────────────────────────────

type FakeWrkfOverrides = {
  runStart?: () => Promise<unknown>
  bindExternal?: (params: Record<string, unknown>) => Promise<unknown>
}

type InstrumentedWrkfPort = AcpWrkfWorkflowPort & {
  _calls: Array<{ method: string; params: unknown }>
}

function makeFakeWrkfPort(overrides: FakeWrkfOverrides = {}): InstrumentedWrkfPort {
  const _calls: Array<{ method: string; params: unknown }> = []
  const boom = (name: string) => (): never => {
    throw new Error(`fake wrkf: ${name} must not be called in this test scenario`)
  }

  return {
    _calls,
    workflow: {
      validate: boom('workflow.validate'),
      show: boom('workflow.show'),
      list: boom('workflow.list'),
      diff: boom('workflow.diff'),
      install: boom('workflow.install'),
    },
    task: {
      attach: boom('task.attach'),
      inspect: async (params) => {
        _calls.push({ method: 'task.inspect', params })
        return { task: CANNED_TASK, instance: CANNED_INSTANCE }
      },
      timeline: async (params) => {
        _calls.push({ method: 'task.timeline', params })
        return []
      },
      refresh: boom('task.refresh'),
      syncMeta: boom('task.syncMeta'),
    },
    next: async (params) => {
      _calls.push({ method: 'next', params })
      return CANNED_NEXT
    },
    evidence: {
      add: boom('evidence.add'),
      list: boom('evidence.list'),
      show: boom('evidence.show'),
      suggest: boom('evidence.suggest'),
    },
    obligation: {
      list: boom('obligation.list'),
      show: boom('obligation.show'),
      satisfy: boom('obligation.satisfy'),
      waive: boom('obligation.waive'),
      cancel: boom('obligation.cancel'),
    },
    transition: { apply: boom('transition.apply') },
    run: {
      start: async (params) => {
        _calls.push({ method: 'run.start', params })
        return overrides.runStart !== undefined ? overrides.runStart() : CANNED_WRKF_RUN
      },
      bindExternal: async (params) => {
        _calls.push({ method: 'run.bindExternal', params })
        if (overrides.bindExternal !== undefined) {
          return overrides.bindExternal(params as Record<string, unknown>)
        }
        return {
          ...CANNED_WRKF_RUN,
          externalRunRef: (params as Record<string, unknown>)['externalRunRef'],
        }
      },
      finish: boom('run.finish'),
      fail: boom('run.fail'),
      show: boom('run.show'),
      list: boom('run.list'),
    },
    effect: {
      list: boom('effect.list'),
      show: boom('effect.show'),
      claim: boom('effect.claim'),
      ack: boom('effect.ack'),
      fail: boom('effect.fail'),
      retry: boom('effect.retry'),
      deliver: boom('effect.deliver'),
    },
  } as InstrumentedWrkfPort
}

/** Minimal runtimeResolver to avoid notFound in placement resolution */
const FAKE_RUNTIME_RESOLVER: RuntimeResolver = async () => ({
  agentRoot: '/tmp/agents/larry',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition was not met before timeout')
}

/** Canonical base input for launchParticipant */
const BASE_INPUT = {
  taskId: TASK_ID,
  role: ROLE,
  actor: { kind: 'agent' as const, id: 'larry' },
  idempotencyKey: IDEMPOTENCY_KEY,
  sessionRef: SESSION_REF,
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('launchParticipant — happy path (W4b red)', () => {
  test('[RED] returns {source:"wrkf"} result on successful launch', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    const result = (await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )) as LaunchResult

    expect(result.source).toBe('wrkf')
    expect(result.taskId).toBe(TASK_ID)
    expect(result.instanceId).toBe(CANNED_INSTANCE.instanceId)
    expect(result.workflowRef).toBe(CANNED_INSTANCE.workflowRef)
    expect(result.revision).toBe(CANNED_INSTANCE.revision)
    expect(result.replay).toBe(false)
  })

  test('[RED] wrkfRun is the run object returned by wrkf.run.start', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    const result = (await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )) as LaunchResult

    expect(result.wrkfRun).toMatchObject({ id: CANNED_WRKF_RUN.id, role: ROLE })
  })

  test('[RED] launch field contains HRC identity returned by launchRoleScopedRun', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    const result = (await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )) as LaunchResult

    expect(result.launch).toMatchObject({
      runId: CANNED_LAUNCHED.runId,
      hostSessionId: CANNED_LAUNCHED.hostSessionId,
      runtimeId: CANNED_LAUNCHED.runtimeId,
    })
  })

  test('[RED] calls wrkf.task.inspect before wrkf.next before wrkf.run.start', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const methodOrder = wrkf._calls.map((c) => c.method)
    expect(methodOrder[0]).toBe('task.inspect')
    expect(methodOrder[1]).toBe('next')
    expect(methodOrder[2]).toBe('run.start')
  })

  test('[RED] wrkf.task.inspect is called with the taskId', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const inspectCall = wrkf._calls.find((c) => c.method === 'task.inspect')
    expect(inspectCall).toBeDefined()
    expect((inspectCall!.params as Record<string, unknown>)['task']).toBe(TASK_ID)
  })

  test('[RED] wrkf.run.start is called with task, role, actor, idempotencyKey', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const startCall = wrkf._calls.find((c) => c.method === 'run.start')
    expect(startCall).toBeDefined()
    const p = startCall!.params as Record<string, unknown>
    expect(p['task']).toBe(TASK_ID)
    expect(p['role']).toBe(ROLE)
    expect(p['idempotencyKey']).toBe(IDEMPOTENCY_KEY)
  })

  test('[RED] launchRoleScopedRun is called with the sessionRef and acpRunId', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    expect(launchCalls).toHaveLength(1)
    const call = launchCalls[0] as { sessionRef: unknown; acpRunId: unknown }
    expect(call.sessionRef).toEqual(SESSION_REF)
    // acpRunId is the deterministic ACP run ID created by createOrGetRun
    expect(call.acpRunId).toBe(`run_wrkf_${CANNED_WRKF_RUN.id}`)
  })

  test('[RED] wrkf.run.bindExternal is called with wrkfRun.id and launched.runId as externalRunRef', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const bindCall = wrkf._calls.find((c) => c.method === 'run.bindExternal')
    expect(bindCall).toBeDefined()
    const p = bindCall!.params as Record<string, unknown>
    expect(p['runId']).toBe(CANNED_WRKF_RUN.id)
    expect(p['externalRunRef']).toBe(CANNED_LAUNCHED.runId)
  })

  test('[RED] bindExternal idempotencyKey is derived from input idempotencyKey with :bindExternal suffix', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const bindCall = wrkf._calls.find((c) => c.method === 'run.bindExternal')
    expect(bindCall).toBeDefined()
    const p = bindCall!.params as Record<string, unknown>
    expect(p['idempotencyKey']).toBe(`${IDEMPOTENCY_KEY}:bindExternal`)
  })

  test('[RED] bindExternal deliveryRef is a JSON string with kind:"hrc"', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const bindCall = wrkf._calls.find((c) => c.method === 'run.bindExternal')
    const p = bindCall!.params as Record<string, unknown>
    const deliveryRef = p['deliveryRef'] as string
    expect(typeof deliveryRef).toBe('string')
    const decoded = JSON.parse(deliveryRef) as Record<string, unknown>
    expect(decoded['kind']).toBe('hrc')
  })

  test('[RED] createOrGetRun creates ACP dispatch fence keyed off wrkfRun.id', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const acpRunId = `run_wrkf_${CANNED_WRKF_RUN.id}`
    const acpRun = runStore.getRun(acpRunId)
    expect(acpRun).toBeDefined()
    expect(acpRun?.metadata?.['source']).toBe('wrkf')
    expect(acpRun?.metadata?.['wrkfRunId']).toBe(CANNED_WRKF_RUN.id)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — Split-failure matrix (daedalus risk #1)
// ─────────────────────────────────────────────────────────────────────────────

describe('launchParticipant — SF1: run.start ok, HRC launch fails (W4b red)', () => {
  test('[RED] surfaced error propagates when launchRoleScopedRun throws', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => {
      throw new Error('HRC socket timeout')
    }

    await expect(
      launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow('HRC socket timeout')
  })

  test('[RED] wrkf.run.bindExternal is NOT called when HRC launch fails', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => {
      throw new Error('HRC socket timeout')
    }

    try {
      await launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    } catch {
      // expected
    }

    const bindCall = wrkf._calls.find((c) => c.method === 'run.bindExternal')
    expect(bindCall).toBeUndefined()
  })

  test('[RED] ACP dispatch fence IS recorded even when HRC launch fails (createOrGetRun committed before launch)', async () => {
    // createOrGetRun must happen BEFORE launchRoleScopedRun so the dispatch fence
    // exists regardless of launch outcome. If the fence is only written after a
    // successful launch, crash-window recovery cannot find it.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => {
      throw new Error('HRC socket timeout')
    }

    try {
      await launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    } catch {
      // expected
    }

    const acpRunId = `run_wrkf_${CANNED_WRKF_RUN.id}`
    const acpRun = runStore.getRun(acpRunId)
    expect(acpRun).toBeDefined()
    // hrcRunId should NOT be set since launch failed
    expect(acpRun?.hrcRunId).toBeUndefined()
  })
})

describe('launchParticipant — SF2: HRC launch ok, bindExternal fails (W4b red)', () => {
  test('[RED] surfaced error propagates when wrkf.run.bindExternal throws', async () => {
    const wrkf = makeFakeWrkfPort({
      bindExternal: async () => {
        throw new WrkfError('WRKF_CONFLICT', 'bindExternal: conflicting external ref')
      },
    })
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await expect(
      launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()
  })

  test('[RED] ACP run records hrcRunId from successful launch even when bindExternal fails (crash-window anchor)', async () => {
    // The ACP run's hrcRunId must be written BEFORE bindExternal is called.
    // This is the critical ordering invariant: hrcRunId is set on the acpRun
    // immediately after launchRoleScopedRun returns, so that a subsequent retry
    // can discover the already-launched HRC run without relaunching.
    const wrkf = makeFakeWrkfPort({
      bindExternal: async () => {
        throw new WrkfError('WRKF_CONFLICT', 'bindExternal conflict')
      },
    })
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    try {
      await launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    } catch {
      // expected
    }

    const acpRunId = `run_wrkf_${CANNED_WRKF_RUN.id}`
    const acpRun = runStore.getRun(acpRunId)
    expect(acpRun).toBeDefined()
    // hrcRunId must be recorded even though bindExternal failed
    expect(acpRun?.hrcRunId).toBe(CANNED_LAUNCHED.runId)
  })
})

describe('launchParticipant — SF3: retry after run.start, no externalRunRef yet (W4b red)', () => {
  test('[RED] retry after ambiguous HRC launch failure does not relaunch blindly', async () => {
    // wrkf.run.start is idempotent by idempotencyKey and always returns same run.
    // The service should call run.start each attempt (wrkf handles dedup).
    // On retry (no externalRunRef), service must proceed to launch+bind.
    let runStartCount = 0
    const wrkf = makeFakeWrkfPort({
      runStart: async () => {
        runStartCount++
        return CANNED_WRKF_RUN // always same run, no externalRunRef
      },
    })
    const runStore = new InMemoryRunStore()
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount++
      if (launchCount === 1) throw new Error('first launch fails')
      return { ...CANNED_LAUNCHED, runId: 'hrc-run-retry-001' }
    }

    // First attempt: run.start ok, launch fails
    try {
      await launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    } catch {
      // expected
    }

    // Second attempt: same idempotencyKey, no externalRunRef, but the durable
    // launch claim marks the prior HRC dispatch outcome ambiguous. Do not
    // launch a second HRC run.
    await expect(
      launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()

    // run.start called once per launchParticipant invocation (2 total)
    expect(runStartCount).toBe(2)
    // launcher called only once; retry is blocked by durable claim state
    expect(launchCount).toBe(1)
  })

  test('[RED] retry preserves same wrkf run ID in durable launch-failed marker', async () => {
    const wrkf = makeFakeWrkfPort({
      runStart: async () => CANNED_WRKF_RUN,
    })
    const runStore = new InMemoryRunStore()
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount++
      if (launchCount === 1) throw new Error('first launch fails')
      return CANNED_LAUNCHED
    }

    try {
      await launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    } catch {
      /* expected */
    }

    await expect(
      launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()

    const acpRun = runStore.getRun(`run_wrkf_${CANNED_WRKF_RUN.id}`)
    expect(acpRun?.metadata?.['wrkfLaunchClaim']).toMatchObject({
      status: 'launch_failed',
      wrkfRunId: CANNED_WRKF_RUN.id,
      errorCode: 'wrkf_launch_failed_ambiguous',
    })
  })
})

describe('launchParticipant — Option B durable launch claim (daedalus unblock)', () => {
  test('[RED] concurrent same-key attempts acquire one durable claim and launch only once', async () => {
    const wrkf = makeFakeWrkfPort({ runStart: async () => CANNED_WRKF_RUN })
    const runStore = new InMemoryRunStore()
    let releaseLaunch!: () => void
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve
    })
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount++
      await launchGate
      return CANNED_LAUNCHED
    }

    const first = launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )
    await waitFor(() => launchCount === 1)

    const second = launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    await expect(second).rejects.toThrow()
    releaseLaunch()
    await expect(first).resolves.toMatchObject({ source: 'wrkf', replay: false })
    expect(launchCount).toBe(1)
  })

  test('[RED] lost-ack style launcher error leaves no-HRC claim state that blocks relaunch', async () => {
    const wrkf = makeFakeWrkfPort({ runStart: async () => CANNED_WRKF_RUN })
    const runStore = new InMemoryRunStore()
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount++
      throw new Error('HRC accepted run but client lost acknowledgement')
    }

    await expect(
      launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow('lost acknowledgement')

    await expect(
      launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()

    expect(launchCount).toBe(1)
    const acpRun = runStore.getRun(`run_wrkf_${CANNED_WRKF_RUN.id}`)
    expect(acpRun?.hrcRunId).toBeUndefined()
    expect(acpRun?.errorCode).toBe('wrkf_launch_failed_ambiguous')
    expect(acpRun?.metadata?.['wrkfLaunchClaim']).toMatchObject({
      status: 'launch_failed',
      wrkfRunId: CANNED_WRKF_RUN.id,
    })
  })

  test('[RED] bindExternal conflict stores orphan marker and retry does not relaunch', async () => {
    const wrkf = makeFakeWrkfPort({
      runStart: async () => CANNED_WRKF_RUN,
      bindExternal: async () => {
        throw new WrkfError('WRKF_IDEMPOTENCY_MISMATCH', 'conflicting external bind')
      },
    })
    const runStore = new InMemoryRunStore()
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount++
      return CANNED_LAUNCHED
    }

    await expect(
      launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()

    const acpRun = runStore.getRun(`run_wrkf_${CANNED_WRKF_RUN.id}`)
    expect(acpRun?.hrcRunId).toBe(CANNED_LAUNCHED.runId)
    expect(acpRun?.errorCode).toBe('wrkf_bind_external_failed')
    expect(acpRun?.metadata?.['wrkfExternalBind']).toMatchObject({
      status: 'orphaned',
      hrcRunId: CANNED_LAUNCHED.runId,
      wrkfRunId: CANNED_WRKF_RUN.id,
      errorCode: 'WRKF_IDEMPOTENCY_MISMATCH',
    })

    await expect(
      launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()
    expect(launchCount).toBe(1)
  })
})

describe('launchParticipant — SF4: retry after bindExternal succeeds → REPLAY (W4b red)', () => {
  test('[RED] externalRunRef present on wrkf run → replay:true, no new launch', async () => {
    // After a successful bindExternal, wrkf.run.start (idempotent) returns the
    // same run WITH externalRunRef. The service must detect this and replay.
    const wrkf = makeFakeWrkfPort({
      runStart: async () => CANNED_WRKF_RUN_BOUND, // externalRunRef already set
    })
    const runStore = new InMemoryRunStore()
    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    const result = (await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )) as LaunchResult

    expect(result.replay).toBe(true)
    expect(result.source).toBe('wrkf')
    expect(launchCalls).toHaveLength(0)
  })

  test('[RED] replay does not call wrkf.run.bindExternal again', async () => {
    const wrkf = makeFakeWrkfPort({
      runStart: async () => CANNED_WRKF_RUN_BOUND,
    })
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const bindCall = wrkf._calls.find((c) => c.method === 'run.bindExternal')
    expect(bindCall).toBeUndefined()
  })

  test('[RED] replay returns wrkfRun with externalRunRef populated', async () => {
    const wrkf = makeFakeWrkfPort({
      runStart: async () => CANNED_WRKF_RUN_BOUND,
    })
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    const result = (await launchParticipant(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )) as LaunchResult

    const run = result.wrkfRun as typeof CANNED_WRKF_RUN_BOUND
    expect(run.externalRunRef).toBe(CANNED_WRKF_RUN_BOUND.externalRunRef)
  })
})

describe('launchParticipant — SF5: terminal wrkf run rejects launch (W4b red)', () => {
  test('[RED] error propagates when wrkf.run.start throws WRKF_RUN_TERMINAL', async () => {
    const wrkf = makeFakeWrkfPort({
      runStart: async () => {
        throw new WrkfError('WRKF_RUN_TERMINAL', 'cannot restart a completed run')
      },
    })
    const runStore = new InMemoryRunStore()
    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    await expect(
      launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()
  })

  test('[RED] no HRC launch attempt when wrkf.run.start throws WRKF_RUN_TERMINAL', async () => {
    const wrkf = makeFakeWrkfPort({
      runStart: async () => {
        throw new WrkfError('WRKF_RUN_TERMINAL', 'cannot restart a completed run')
      },
    })
    const runStore = new InMemoryRunStore()
    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    try {
      await launchParticipant(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    } catch {
      /* expected */
    }

    expect(launchCalls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section 3 — Crash-window recovery
// ─────────────────────────────────────────────────────────────────────────────

describe('launchParticipant — crash-window recovery (W4b red)', () => {
  test('[RED] crash-after-launch-before-bind: retry discovers hrcRunId from ACP run, calls bindExternal without relaunching', async () => {
    // Simulates: prior attempt called launchRoleScopedRun successfully (hrcRunId
    // recorded in acpRun), but crashed before wrkf.run.bindExternal completed.
    // On retry:
    //   wrkf.run.start → same wrkfRun (no externalRunRef)
    //   createOrGetRun → {run: existingAcpRun, created: false}
    //   existingAcpRun.hrcRunId is set → skip relaunch, bind discovered ref
    const wrkf = makeFakeWrkfPort({
      runStart: async () => CANNED_WRKF_RUN, // no externalRunRef
    })

    // Pre-seed the runStore: simulate state after createOrGetRun + launch + crash before bind
    const seededRunStore = new InMemoryRunStore()
    const { run: seedRun } = seededRunStore.createOrGetRun({
      sessionRef: SESSION_REF,
      wrkfTaskId: TASK_ID,
      wrkfInstanceId: CANNED_INSTANCE.instanceId,
      wrkfRunId: CANNED_WRKF_RUN.id,
      workflowRef: CANNED_INSTANCE.workflowRef,
      role: ROLE,
    })
    // Simulate that the HRC run was launched and hrcRunId was committed to the ACP run
    // before the crash (this is the state launchParticipant must leave BEFORE calling bindExternal)
    seededRunStore.updateRun(seedRun.runId, { hrcRunId: CANNED_LAUNCHED.runId })

    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    const result = (await launchParticipant(
      {
        wrkf,
        runStore: seededRunStore,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      BASE_INPUT
    )) as LaunchResult

    // Must NOT have launched again
    expect(launchCalls).toHaveLength(0)
    // Must have called bindExternal with the discovered hrcRunId
    const bindCall = wrkf._calls.find((c) => c.method === 'run.bindExternal')
    expect(bindCall).toBeDefined()
    const p = bindCall!.params as Record<string, unknown>
    expect(p['externalRunRef']).toBe(CANNED_LAUNCHED.runId)
    // Result source is correct
    expect(result.source).toBe('wrkf')
  })

  test('[RED] bindExternal is the final arbiter: conflicting externalRunRef from ACP run → rejects', async () => {
    // If the ACP run has a different hrcRunId than what wrkf already has bound,
    // wrkf.run.bindExternal must be allowed to reject with WRKF_EXTERNAL_REF_CONFLICT.
    // The service must NOT suppress this error.
    const CONFLICT_HRC_ID = 'hrc-run-conflict-999'

    const wrkf = makeFakeWrkfPort({
      runStart: async () => CANNED_WRKF_RUN,
      bindExternal: async () => {
        throw new WrkfError(
          'WRKF_EXTERNAL_REF_CONFLICT',
          'externalRunRef already bound to a different run'
        )
      },
    })

    const seededRunStore = new InMemoryRunStore()
    const { run: seedRun } = seededRunStore.createOrGetRun({
      sessionRef: SESSION_REF,
      wrkfTaskId: TASK_ID,
      wrkfInstanceId: CANNED_INSTANCE.instanceId,
      wrkfRunId: CANNED_WRKF_RUN.id,
      workflowRef: CANNED_INSTANCE.workflowRef,
      role: ROLE,
    })
    seededRunStore.updateRun(seedRun.runId, { hrcRunId: CONFLICT_HRC_ID })

    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await expect(
      launchParticipant(
        {
          wrkf,
          runStore: seededRunStore,
          launchRoleScopedRun: launcher,
          runtimeResolver: FAKE_RUNTIME_RESOLVER,
        },
        BASE_INPUT
      )
    ).rejects.toThrow()
  })
})
