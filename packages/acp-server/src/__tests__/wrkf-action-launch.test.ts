/**
 * Unit tests — Node D, contract C-0004: ACP wrkf action launch/bind adapter.
 *
 * Mirrors `wrkf-participant-launch.test.ts` but for the action-level adapter
 * (`wrkf/action-launch.ts`). Drives `launchAction` against a FAKE wrkf port and
 * a canned `launchRoleScopedRun` to exercise the idempotency/reconciliation
 * branches in isolation:
 *   - happy path: action.start -> HRC launch -> action.bindExternal
 *   - replay: action.start returns an already-bound run -> no relaunch, no bind
 *   - crash-window: ACP run carries hrcRunId before bind -> re-bind, no relaunch
 *   - orphan: bindExternal fails -> wrkfExternalBind.status='orphaned', surfaced,
 *     and a retry does NOT relaunch HRC
 *   - durable claim: ambiguous launch failure blocks a second HRC launch
 *
 * The real-wrkf / real idempotency proof lives in the acp-e2e gate
 * (`packages/acp-e2e/test/wrkf-action-launch.e2e.test.ts`).
 */

import { describe, expect, test } from 'bun:test'

import { formatHrcExternalRef } from 'acp-core'

import type { LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
import { InMemoryRunStore } from '../domain/run-store.js'
import { launchAction } from '../wrkf/action-launch.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TASK_ID = 'T-09991'
const ACTION = 'implement'
const ROLE = 'implementer'
const IDEMPOTENCY_KEY = 'wrkf-action-test-001'
const SESSION_REF = { scopeRef: 'agent:curly:project:acps-test:task:T-09991', laneRef: 'main' }

/** action.start result with no external ref bound yet (pre-bind state). */
const CANNED_ACTION_RUN = {
  actionRunId: 'actrun-bbb222',
  runId: 'actrun-bbb222',
  task: TASK_ID,
  instanceId: 'wfi-aaa111',
  workflow: { id: 'wrkq-simple-task', version: '1' },
  action: ACTION,
  role: ROLE,
  lane: 'implementation',
  status: 'active',
}

/** action.start result when the action run already carries a bound ref (replay). */
const CANNED_ACTION_RUN_BOUND = {
  ...CANNED_ACTION_RUN,
  externalRunRef: 'hrc:hrc-run-already-launched-001',
}

const CANNED_LAUNCHED = {
  runId: 'hrc-run-launched-001',
  sessionId: 'host-session-001',
  hostSessionId: 'host-session-001',
  runtimeId: 'runtime-001',
  launchId: 'launch-001',
  generation: 3,
}

const ACP_RUN_ID = `run_wrkf_${CANNED_ACTION_RUN.runId}`

class WrkfError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WrkfError'
  }
}

type FakeOverrides = {
  start?: () => Promise<unknown>
  bindExternal?: (params: Record<string, unknown>) => Promise<unknown>
  fail?: (params: Record<string, unknown>) => Promise<unknown>
}

type InstrumentedPort = AcpWrkfWorkflowPort & {
  _calls: Array<{ method: string; params: unknown }>
}

function makeFakeWrkfPort(overrides: FakeOverrides = {}): InstrumentedPort {
  const _calls: Array<{ method: string; params: unknown }> = []
  return {
    _calls,
    action: {
      start: async (params: unknown) => {
        _calls.push({ method: 'action.start', params })
        return overrides.start !== undefined ? overrides.start() : CANNED_ACTION_RUN
      },
      bindExternal: async (params: unknown) => {
        _calls.push({ method: 'action.bindExternal', params })
        if (overrides.bindExternal !== undefined) {
          return overrides.bindExternal(params as Record<string, unknown>)
        }
        return {
          ...CANNED_ACTION_RUN,
          externalRunRef: (params as Record<string, unknown>)['externalRunRef'],
        }
      },
      fail: async (params: unknown) => {
        _calls.push({ method: 'action.fail', params })
        if (overrides.fail !== undefined) {
          return overrides.fail(params as Record<string, unknown>)
        }
        return { ...CANNED_ACTION_RUN, status: 'failed' }
      },
    },
  } as unknown as InstrumentedPort
}

const FAKE_RUNTIME_RESOLVER: RuntimeResolver = async () => ({
  agentRoot: '/tmp/agents/curly',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
})

const BASE_INPUT = {
  taskId: TASK_ID,
  action: ACTION,
  actor: { kind: 'agent' as const, id: 'curly' },
  idempotencyKey: IDEMPOTENCY_KEY,
  sessionRef: SESSION_REF,
}

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('launchAction — happy path', () => {
  test('composes action.start -> launch -> action.bindExternal and returns both ids', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    const result = await launchAction(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    expect(result.source).toBe('wrkf-action')
    expect(result.taskId).toBe(TASK_ID)
    expect(result.actionRunId).toBe(CANNED_ACTION_RUN.actionRunId)
    expect(result.wrkfRunId).toBe(CANNED_ACTION_RUN.runId)
    expect(result.hrcRunId).toBe(CANNED_LAUNCHED.runId)
    expect(result.externalRunRef).toBe(formatHrcExternalRef(CANNED_LAUNCHED.runId))
    expect(result.replay).toBe(false)
    expect(result.launch?.runId).toBe(CANNED_LAUNCHED.runId)
  })

  test('action.start is called with task, action, string actor and idempotencyKey', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchAction(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const startCall = wrkf._calls.find((c) => c.method === 'action.start')
    const p = startCall!.params as Record<string, unknown>
    expect(p['task']).toBe(TASK_ID)
    expect(p['action']).toBe(ACTION)
    expect(p['principal_ref']).toBe('agent:curly')
    expect(p['idempotencyKey']).toBe(IDEMPOTENCY_KEY)
  })

  test('bindExternal keys on actionRunId with prefixed hrc ref and :bindExternal key', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchAction(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const bindCall = wrkf._calls.find((c) => c.method === 'action.bindExternal')
    const p = bindCall!.params as Record<string, unknown>
    expect(p['actionRunId']).toBe(CANNED_ACTION_RUN.actionRunId)
    expect(p['externalRunRef']).toBe(formatHrcExternalRef(CANNED_LAUNCHED.runId))
    expect(p['idempotencyKey']).toBe(`${IDEMPOTENCY_KEY}:bindExternal`)
    const deliveryRef = JSON.parse(p['deliveryRef'] as string) as Record<string, unknown>
    expect(deliveryRef['kind']).toBe('hrc')
  })

  test('ACP run store is keyed on the underlying runId and records hrcRunId before bind', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchAction(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const acpRun = runStore.getRun(ACP_RUN_ID)
    expect(acpRun).toBeDefined()
    expect(acpRun?.hrcRunId).toBe(CANNED_LAUNCHED.runId)
    expect(acpRun?.metadata?.['wrkfRunId']).toBe(CANNED_ACTION_RUN.runId)
  })

  test('does NOT persist semantic action-truth scalars (cp_*, session_id, run_status) in ACP run', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await launchAction(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const acpRun = runStore.getRun(ACP_RUN_ID)
    const blob = JSON.stringify(acpRun)
    expect(blob).not.toContain('cp_run_id')
    expect(blob).not.toContain('cp_session_id')
    expect(blob).not.toContain('run_status')
    expect(blob).not.toContain('sdk_session_id')
  })
})

// ─── Replay: action.start already bound ──────────────────────────────────────

describe('launchAction — replay (action already bound)', () => {
  test('externalRunRef present on action.start → replay:true, no launch, no bind', async () => {
    const wrkf = makeFakeWrkfPort({ start: async () => CANNED_ACTION_RUN_BOUND })
    const runStore = new InMemoryRunStore()
    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    const result = await launchAction(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    expect(result.replay).toBe(true)
    expect(result.externalRunRef).toBe(CANNED_ACTION_RUN_BOUND.externalRunRef)
    expect(result.hrcRunId).toBe('hrc-run-already-launched-001')
    expect(launchCalls).toHaveLength(0)
    expect(wrkf._calls.find((c) => c.method === 'action.bindExternal')).toBeUndefined()
  })
})

// ─── Crash-window recovery ───────────────────────────────────────────────────

describe('launchAction — crash-window recovery', () => {
  test('retry after launch-before-bind re-binds discovered hrcRunId without relaunching', async () => {
    const wrkf = makeFakeWrkfPort({ start: async () => CANNED_ACTION_RUN })
    const runStore = new InMemoryRunStore()
    const { run: seed } = runStore.createOrGetRun({
      sessionRef: SESSION_REF,
      wrkfTaskId: TASK_ID,
      wrkfInstanceId: CANNED_ACTION_RUN.instanceId,
      wrkfRunId: CANNED_ACTION_RUN.runId,
      workflowRef: 'wrkq-simple-task@1',
      role: ROLE,
    })
    runStore.updateRun(seed.runId, { hrcRunId: CANNED_LAUNCHED.runId })

    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    const result = await launchAction(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    expect(launchCalls).toHaveLength(0)
    const bindCall = wrkf._calls.find((c) => c.method === 'action.bindExternal')
    const p = bindCall!.params as Record<string, unknown>
    expect(p['externalRunRef']).toBe(formatHrcExternalRef(CANNED_LAUNCHED.runId))
    expect(result.hrcRunId).toBe(CANNED_LAUNCHED.runId)
  })
})

// ─── Orphan on bind failure ──────────────────────────────────────────────────

describe('launchAction — bind failure → orphan', () => {
  test('bind conflict stores orphan marker, surfaces error, and retry does not relaunch', async () => {
    const wrkf = makeFakeWrkfPort({
      start: async () => CANNED_ACTION_RUN,
      bindExternal: async () => {
        throw new WrkfError('WRKF_EXTERNAL_REF_CONFLICT', 'conflicting external bind')
      },
    })
    const runStore = new InMemoryRunStore()
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount++
      return CANNED_LAUNCHED
    }

    await expect(
      launchAction(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()

    const acpRun = runStore.getRun(ACP_RUN_ID)
    expect(acpRun?.hrcRunId).toBe(CANNED_LAUNCHED.runId)
    expect(acpRun?.errorCode).toBe('wrkf_bind_external_failed')
    expect(acpRun?.metadata?.['wrkfExternalBind']).toMatchObject({
      status: 'orphaned',
      hrcRunId: CANNED_LAUNCHED.runId,
      actionRunId: CANNED_ACTION_RUN.actionRunId,
      errorCode: 'WRKF_EXTERNAL_REF_CONFLICT',
    })

    // T-05039: a launched-but-unbound action must be terminalized — not left active
    // forever. The adapter records wrkf.action.fail once, carrying the orphaned
    // hrcRunId as correlation evidence.
    const failCalls = wrkf._calls.filter((c) => c.method === 'action.fail')
    expect(failCalls).toHaveLength(1)
    const failParams = failCalls[0]!.params as Record<string, unknown>
    expect(failParams['actionRunId']).toBe(CANNED_ACTION_RUN.actionRunId)
    expect((failParams['failureResult'] as Record<string, unknown>)['hrcRunId']).toBe(
      formatHrcExternalRef(CANNED_LAUNCHED.runId)
    )

    // Retry: orphan marker blocks relaunch.
    await expect(
      launchAction(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()
    expect(launchCount).toBe(1)
  })
})

// ─── Durable launch claim blocks ambiguous relaunch ──────────────────────────

describe('launchAction — durable launch claim', () => {
  test('ambiguous launch failure marks claim launch_failed and blocks a second HRC launch', async () => {
    const wrkf = makeFakeWrkfPort({ start: async () => CANNED_ACTION_RUN })
    const runStore = new InMemoryRunStore()
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount++
      throw new Error('HRC accepted run but client lost acknowledgement')
    }

    await expect(
      launchAction(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow('lost acknowledgement')

    await expect(
      launchAction(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow()

    expect(launchCount).toBe(1)
    const acpRun = runStore.getRun(ACP_RUN_ID)
    expect(acpRun?.hrcRunId).toBeUndefined()
    expect(acpRun?.errorCode).toBe('wrkf_launch_failed_ambiguous')
    expect(acpRun?.metadata?.['wrkfLaunchClaim']).toMatchObject({
      status: 'launch_failed',
      wrkfRunId: CANNED_ACTION_RUN.runId,
    })

    // T-05039: the launch failed after action.start, so the still-active action
    // run must be terminalized (rolled back) exactly once — not left dangling.
    // The second attempt is blocked at the durable claim BEFORE the launch region,
    // so it does not re-fail.
    const failCalls = wrkf._calls.filter((c) => c.method === 'action.fail')
    expect(failCalls).toHaveLength(1)
    expect((failCalls[0]!.params as Record<string, unknown>)['actionRunId']).toBe(
      CANNED_ACTION_RUN.actionRunId
    )
  })
})

// ─── Launch-phase failure rolls back the action (T-05039) ────────────────────

describe('launchAction — rollback on launch-phase failure', () => {
  test('resolveLaunchIntent failure after action.start fails the action once, then rethrows', async () => {
    // This is the live repro: the worker scope had no resolvable runtime placement
    // (e.g. the old `agent:acp-local` default with no agent-profile.toml), so launch
    // intent resolution threw AFTER action.start — stranding the action active with
    // no externalRunRef. The adapter must terminalize the action (wrkf.action.fail)
    // and surface the ORIGINAL placement error.
    const wrkf = makeFakeWrkfPort({ start: async () => CANNED_ACTION_RUN })
    const runStore = new InMemoryRunStore()
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount++
      return CANNED_LAUNCHED
    }
    // A runtimeResolver that resolves no agentRoot → resolveLaunchPlacement throws
    // a notFound placement error before any HRC launch is attempted.
    const noPlacementResolver: RuntimeResolver = async () => undefined as never

    await expect(
      launchAction(
        {
          wrkf,
          runStore,
          launchRoleScopedRun: launcher,
          runtimeResolver: noPlacementResolver,
        },
        BASE_INPUT
      )
    ).rejects.toThrow()

    // No HRC launch happened — the failure was pre-launch (intent resolution).
    expect(launchCount).toBe(0)
    // The action was terminalized exactly once with its actionRunId.
    const failCalls = wrkf._calls.filter((c) => c.method === 'action.fail')
    expect(failCalls).toHaveLength(1)
    const failParams = failCalls[0]!.params as Record<string, unknown>
    expect(failParams['actionRunId']).toBe(CANNED_ACTION_RUN.actionRunId)
    expect(typeof failParams['summary']).toBe('string')
    expect(typeof failParams['idempotencyKey']).toBe('string')
  })

  test('action.fail rollback errors are swallowed so the ORIGINAL launch error surfaces', async () => {
    // Best-effort terminalization must never mask the real failure cause.
    const wrkf = makeFakeWrkfPort({
      start: async () => CANNED_ACTION_RUN,
      fail: async () => {
        throw new Error('wrkf unreachable during rollback')
      },
    })
    const runStore = new InMemoryRunStore()
    const launcher: LaunchRoleScopedRun = async () => {
      throw new Error('original launcher failure')
    }

    await expect(
      launchAction(
        { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
        BASE_INPUT
      )
    ).rejects.toThrow('original launcher failure')

    // The rollback was attempted (once) even though it threw.
    expect(wrkf._calls.filter((c) => c.method === 'action.fail')).toHaveLength(1)
  })
})
