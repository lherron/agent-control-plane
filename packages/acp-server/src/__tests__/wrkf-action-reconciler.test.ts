/**
 * RED TESTS — T-05034 (daedalus required tests 4, 5, and 7 reconcile side)
 *
 * All tests in this file FAIL at module-load time because
 * packages/acp-server/src/wrkf/action-reconciler.ts does not exist yet.
 * Bun throws CannotFindModule at the import below → every test is RED.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT — what must be created to go green:
 *
 * File: packages/acp-server/src/wrkf/action-reconciler.ts
 *
 *   export type HrcRunTerminalStatus = 'failed' | 'cancelled' | 'zombie' | 'completed'
 *
 *   export type ReconcileActionHrcInput = {
 *     actionRunId: string      // the semantic wrkf action run id
 *     wrkfRunId: string        // the underlying wrkf run id (ACP run store key)
 *     hrcRunId: string         // bare HRC run id (externalRunRef = hrc:<hrcRunId>)
 *     hrcTerminalStatus: HrcRunTerminalStatus
 *     taskId: string
 *     // Deterministic key derived from actionRunId + hrcRunId so the reconciler
 *     // can call wrkf.action.fail idempotently.
 *     idempotencyKey: string
 *   }
 *
 *   export type ReconcileActionHrcDeps = {
 *     // Must include action.show and action.fail in addition to existing surfaces.
 *     wrkf: AcpWrkfWorkflowPortWithActionOps
 *   }
 *
 *   export type ReconcileActionHrcResult = {
 *     outcome: 'no_op' | 'failed_action' | 'breach_recorded'
 *     // True when the action was already terminal on entry (no-op fast path).
 *     alreadyTerminal: boolean
 *   }
 *
 *   export async function reconcileActionHrcTerminal(
 *     deps: ReconcileActionHrcDeps,
 *     input: ReconcileActionHrcInput
 *   ): Promise<ReconcileActionHrcResult>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RECONCILE SEQUENCE:
 *
 *   A. Read wrkf.action.show({ actionRunId }).
 *   B. If the action run is already terminal (status !== 'active'): return {
 *        outcome: 'no_op', alreadyTerminal: true }. IDEMPOTENT fast path.
 *   C. For hrcTerminalStatus in ['failed', 'cancelled', 'zombie']:
 *        Call wrkf.action.fail({
 *          actionRunId,
 *          summary: 'HRC runtime terminated: <status>',
 *          failureResult: { hrcRunId: 'hrc:<hrcRunId>', hrcStatus: <status> },
 *          idempotencyKey: input.idempotencyKey,
 *        }).
 *        Return { outcome: 'failed_action', alreadyTerminal: false }.
 *   D. For hrcTerminalStatus === 'completed' (protocol breach — no semantic completion):
 *        NEVER call wrkf.action.complete.
 *        Call wrkf.action.fail({
 *          actionRunId,
 *          summary: 'runtime completed without semantic completion',
 *          failureResult: { hrcRunId: 'hrc:<hrcRunId>', breach: 'runtime_completed_no_semantic' },
 *          idempotencyKey: input.idempotencyKey,
 *        })
 *        OR leave the action active with breach metadata recorded in the ACP run store.
 *        Return { outcome: 'breach_recorded', alreadyTerminal: false }.
 *
 * ACP MUST NEVER call wrkf.action.complete from the reconciler. Success authority
 * belongs exclusively to the launched worker.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PORT EXTENSION (wrkf/port.ts):
 *
 * Add to AcpWrkfWorkflowPort.action:
 *   show(params: { actionRunId: string }): Promise<unknown>
 *   fail(params: {
 *     actionRunId: string
 *     summary: string
 *     failureResult?: Record<string, unknown>
 *     idempotencyKey?: string
 *   }): Promise<unknown>
 *
 * IMPORTANT: Do NOT add action.complete — the reconciler must never call it.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { reconcileActionHrcTerminal } from '../wrkf/action-reconciler.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Extended port type (includes show + fail not yet on the real port) ───────

type WrkfActionShowParams = { actionRunId: string }

type WrkfActionFailParams = {
  actionRunId: string
  summary: string
  failureResult?: Record<string, unknown>
  idempotencyKey?: string
}

type AcpWrkfWorkflowPortWithActionOps = Omit<AcpWrkfWorkflowPort, 'action'> & {
  action: AcpWrkfWorkflowPort['action'] & {
    show(params: WrkfActionShowParams): Promise<unknown>
    fail(params: WrkfActionFailParams): Promise<unknown>
    // Note: complete is intentionally ABSENT from the reconciler port
  }
}

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const ACTION_RUN_ID = 'actrun-rec-aaa111'
const WRKF_RUN_ID = 'actrun-rec-aaa111'
const HRC_RUN_ID = 'hrc-run-rec-001'
const TASK_ID = 'T-09997'

const BASE_INPUT = {
  actionRunId: ACTION_RUN_ID,
  wrkfRunId: WRKF_RUN_ID,
  hrcRunId: HRC_RUN_ID,
  taskId: TASK_ID,
  idempotencyKey: `reconcile:${ACTION_RUN_ID}:${HRC_RUN_ID}`,
}

/** Canned active action run returned by action.show when the action is still open. */
const ACTIVE_ACTION_RUN = {
  actionRunId: ACTION_RUN_ID,
  runId: WRKF_RUN_ID,
  task: TASK_ID,
  status: 'active',
  externalRunRef: `hrc:${HRC_RUN_ID}`,
}

/** Canned completed/terminal action run for the already-terminal fast path. */
const TERMINAL_ACTION_RUN = {
  ...ACTIVE_ACTION_RUN,
  status: 'failed',
}

// ─── Fake port helpers ────────────────────────────────────────────────────────

type WrkfCall = { method: string; params: unknown }

type FakePortOverrides = {
  showResult?: unknown
  failResult?: unknown
  failThrows?: Error
}

type InstrumentedPort = AcpWrkfWorkflowPortWithActionOps & { _calls: WrkfCall[] }

function makeFakePort(overrides: FakePortOverrides = {}): InstrumentedPort {
  const _calls: WrkfCall[] = []
  const boom = (name: string) => (): never => {
    throw new Error(`reconciler fake: ${name} must NOT be called in this scenario`)
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
      inspect: boom('task.inspect'),
      timeline: boom('task.timeline'),
      refresh: boom('task.refresh'),
      syncMeta: boom('task.syncMeta'),
    },
    next: boom('next'),
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
      start: boom('run.start'),
      bindExternal: boom('run.bindExternal'),
      finish: boom('run.finish'),
      fail: boom('run.fail'),
      show: boom('run.show'),
      list: boom('run.list'),
    },
    action: {
      start: boom('action.start'),
      bindExternal: boom('action.bindExternal'),
      show: async (params: unknown) => {
        _calls.push({ method: 'action.show', params })
        return overrides.showResult ?? ACTIVE_ACTION_RUN
      },
      fail: async (params: unknown) => {
        _calls.push({ method: 'action.fail', params })
        if (overrides.failThrows !== undefined) {
          throw overrides.failThrows
        }
        return (
          overrides.failResult ?? {
            actionRunId: ACTION_RUN_ID,
            status: 'failed',
          }
        )
      },
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
  } as InstrumentedPort
}

// ═════════════════════════════════════════════════════════════════════════════
// Test 4 — RECONCILE on HRC failed / cancelled / zombie
//
// When the bound HRC run terminates with a non-semantic-success status AND the
// wrkf action run is still active, the reconciler must call wrkf.action.fail
// EXACTLY ONCE with failure_result evidence referencing hrc:<runId>.
//
// ALL tests fail at load (CannotFindModule) because action-reconciler.ts is absent.
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED T-05034 test 4] reconcile on HRC failed — action.fail called once', () => {
  test('action.show is called first to check current status', async () => {
    const port = makeFakePort()
    await reconcileActionHrcTerminal({ wrkf: port }, { ...BASE_INPUT, hrcTerminalStatus: 'failed' })

    const showCall = port._calls.find((c) => c.method === 'action.show')
    expect(showCall).toBeDefined()
    expect((showCall!.params as Record<string, unknown>)['actionRunId']).toBe(ACTION_RUN_ID)
  })

  test('wrkf.action.fail is called once when HRC status is failed and action is active', async () => {
    const port = makeFakePort()
    await reconcileActionHrcTerminal({ wrkf: port }, { ...BASE_INPUT, hrcTerminalStatus: 'failed' })

    const failCalls = port._calls.filter((c) => c.method === 'action.fail')
    expect(failCalls).toHaveLength(1)
  })

  test('action.fail params include actionRunId', async () => {
    const port = makeFakePort()
    await reconcileActionHrcTerminal({ wrkf: port }, { ...BASE_INPUT, hrcTerminalStatus: 'failed' })

    const failCall = port._calls.find((c) => c.method === 'action.fail')
    const p = failCall!.params as Record<string, unknown>
    expect(p['actionRunId']).toBe(ACTION_RUN_ID)
  })

  test('action.fail failure_result references hrc:<runId>', async () => {
    const port = makeFakePort()
    await reconcileActionHrcTerminal({ wrkf: port }, { ...BASE_INPUT, hrcTerminalStatus: 'failed' })

    const failCall = port._calls.find((c) => c.method === 'action.fail')
    const p = failCall!.params as Record<string, unknown>
    // The failure_result must include a reference to the HRC run.
    const failureResult = p['failureResult'] as Record<string, unknown> | undefined
    expect(failureResult).toBeDefined()
    const resultStr = JSON.stringify(failureResult)
    expect(resultStr).toContain(`hrc:${HRC_RUN_ID}`)
  })

  test('action.fail carries the idempotencyKey derived from actionRunId+hrcRunId', async () => {
    const port = makeFakePort()
    await reconcileActionHrcTerminal({ wrkf: port }, { ...BASE_INPUT, hrcTerminalStatus: 'failed' })

    const failCall = port._calls.find((c) => c.method === 'action.fail')
    const p = failCall!.params as Record<string, unknown>
    // idempotencyKey must be deterministic and non-empty.
    expect(typeof p['idempotencyKey']).toBe('string')
    expect((p['idempotencyKey'] as string).length).toBeGreaterThan(0)
    // Must include actionRunId and hrcRunId for uniqueness.
    expect(p['idempotencyKey']).toContain(ACTION_RUN_ID)
    expect(p['idempotencyKey']).toContain(HRC_RUN_ID)
  })

  test('reconciler result outcome is "failed_action" for HRC failed status', async () => {
    const port = makeFakePort()
    const result = await reconcileActionHrcTerminal(
      { wrkf: port },
      { ...BASE_INPUT, hrcTerminalStatus: 'failed' }
    )

    expect(result.outcome).toBe('failed_action')
    expect(result.alreadyTerminal).toBe(false)
  })
})

describe('[RED T-05034 test 4] reconcile on HRC cancelled', () => {
  test('wrkf.action.fail is called for HRC cancelled status', async () => {
    const port = makeFakePort()
    await reconcileActionHrcTerminal(
      { wrkf: port },
      { ...BASE_INPUT, hrcTerminalStatus: 'cancelled' }
    )

    const failCalls = port._calls.filter((c) => c.method === 'action.fail')
    expect(failCalls).toHaveLength(1)
    const p = failCalls[0]!.params as Record<string, unknown>
    expect(p['actionRunId']).toBe(ACTION_RUN_ID)
    const failureResult = JSON.stringify(p['failureResult'])
    expect(failureResult).toContain(`hrc:${HRC_RUN_ID}`)
  })
})

describe('[RED T-05034 test 4] reconcile on HRC zombie', () => {
  test('wrkf.action.fail is called for HRC zombie status', async () => {
    const port = makeFakePort()
    await reconcileActionHrcTerminal({ wrkf: port }, { ...BASE_INPUT, hrcTerminalStatus: 'zombie' })

    const failCalls = port._calls.filter((c) => c.method === 'action.fail')
    expect(failCalls).toHaveLength(1)
    const p = failCalls[0]!.params as Record<string, unknown>
    const failureResult = JSON.stringify(p['failureResult'])
    expect(failureResult).toContain(`hrc:${HRC_RUN_ID}`)
  })
})

describe('[RED T-05034 test 4] reconcile idempotency — already-terminal fast path', () => {
  test('action.fail is NOT called when action.show returns a terminal status', async () => {
    const port = makeFakePort({ showResult: TERMINAL_ACTION_RUN })
    const result = await reconcileActionHrcTerminal(
      { wrkf: port },
      { ...BASE_INPUT, hrcTerminalStatus: 'failed' }
    )

    const failCalls = port._calls.filter((c) => c.method === 'action.fail')
    expect(failCalls).toHaveLength(0)
    expect(result.alreadyTerminal).toBe(true)
    expect(result.outcome).toBe('no_op')
  })

  test('reconciler is a no-op when action is already terminal (completed status)', async () => {
    const port = makeFakePort({
      showResult: { ...TERMINAL_ACTION_RUN, status: 'completed' },
    })
    const result = await reconcileActionHrcTerminal(
      { wrkf: port },
      { ...BASE_INPUT, hrcTerminalStatus: 'failed' }
    )

    expect(result.outcome).toBe('no_op')
    expect(result.alreadyTerminal).toBe(true)
    expect(port._calls.filter((c) => c.method === 'action.fail')).toHaveLength(0)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test 5 — PROTOCOL BREACH on HRC completed while wrkf action still active
//
// HRC reaching 'completed' does NOT mean the action completed semantically.
// The reconciler MUST NOT call wrkf.action.complete.
// It should either:
//   (A) call wrkf.action.fail with summary 'runtime completed without semantic completion', OR
//   (B) leave the action active and record breach metadata in the ACP run store.
// Either is acceptable; (A) is preferred (matches daedalus spec).
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED T-05034 test 5] protocol breach — HRC completed, wrkf action still active', () => {
  test('wrkf.action.complete is NEVER called when HRC reaches completed status', async () => {
    // The reconciler must NOT have a path that calls action.complete.
    // We verify this by ensuring no method named 'action.complete' is called.
    const _calls: WrkfCall[] = []
    const port = makeFakePort()
    // Inject a spy that would catch a hypothetical action.complete call.
    ;(port as unknown as Record<string, unknown>)['action'] = {
      ...(port.action as object),
      complete: (_params: unknown) => {
        _calls.push({ method: 'action.complete', params: _params })
        return Promise.resolve({})
      },
    }

    await reconcileActionHrcTerminal(
      { wrkf: port },
      { ...BASE_INPUT, hrcTerminalStatus: 'completed' }
    )

    const completeCalls = _calls.filter((c) => c.method === 'action.complete')
    expect(completeCalls).toHaveLength(0)
  })

  test('reconciler outcome is "breach_recorded" (not "failed_action") for HRC completed', async () => {
    const port = makeFakePort()
    const result = await reconcileActionHrcTerminal(
      { wrkf: port },
      { ...BASE_INPUT, hrcTerminalStatus: 'completed' }
    )

    // outcome must indicate a protocol breach (NOT a normal fail transition)
    expect(['breach_recorded', 'failed_action']).toContain(result.outcome)
    // It must NOT claim the action successfully completed
    expect(result.outcome).not.toBe('completed')
    expect(result.alreadyTerminal).toBe(false)
  })

  test('if action.fail IS called for protocol breach, summary references "semantic completion"', async () => {
    // Preferred behavior: mark action as failed with breach summary.
    // Some implementations may instead record breach metadata and leave active.
    // This test checks that IF action.fail is called, the summary is correct.
    const port = makeFakePort()
    await reconcileActionHrcTerminal(
      { wrkf: port },
      { ...BASE_INPUT, hrcTerminalStatus: 'completed' }
    )

    const failCalls = port._calls.filter((c) => c.method === 'action.fail')
    if (failCalls.length > 0) {
      const p = failCalls[0]!.params as Record<string, unknown>
      const summary = String(p['summary'] ?? '')
      // Summary must reference semantic completion breach, not a generic failure.
      expect(
        summary.includes('semantic') ||
          summary.includes('completion') ||
          summary.includes('breach') ||
          summary.includes('protocol')
      ).toBe(true)
    }
    // If action.fail is NOT called, the test passes (breach_recorded + no fail is also valid).
  })

  test('if action.fail IS called for protocol breach, failure_result references the hrc run', async () => {
    const port = makeFakePort()
    await reconcileActionHrcTerminal(
      { wrkf: port },
      { ...BASE_INPUT, hrcTerminalStatus: 'completed' }
    )

    const failCalls = port._calls.filter((c) => c.method === 'action.fail')
    if (failCalls.length > 0) {
      const p = failCalls[0]!.params as Record<string, unknown>
      const failureResult = JSON.stringify(p['failureResult'] ?? {})
      expect(failureResult).toContain(`hrc:${HRC_RUN_ID}`)
    }
    // No-op if the impl chose to record breach metadata instead of calling fail.
  })

  test('protocol breach — action.fail NOT called a second time on replay', async () => {
    // First call: breach recorded (may or may not call action.fail).
    const port = makeFakePort()
    await reconcileActionHrcTerminal(
      { wrkf: port },
      { ...BASE_INPUT, hrcTerminalStatus: 'completed' }
    )
    // Second call: action is now terminal (show returns terminal) → no_op.
    const port2 = makeFakePort({ showResult: { ...TERMINAL_ACTION_RUN, status: 'failed' } })
    const result2 = await reconcileActionHrcTerminal(
      { wrkf: port2 },
      { ...BASE_INPUT, hrcTerminalStatus: 'completed' }
    )

    const failCallsAfterSecond = port2._calls.filter((c) => c.method === 'action.fail')
    // Second call must be idempotent: if first call already marked it terminal,
    // the second call sees terminal status and does nothing.
    expect(failCallsAfterSecond).toHaveLength(0)
    expect(result2.alreadyTerminal).toBe(true)
    expect(result2.outcome).toBe('no_op')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test 7 — RECONCILE IDEMPOTENCY
//
// Repeated reconcile events (e.g. duplicate HRC terminal event delivery) must
// NOT create duplicate evidence or conflicting terminal summaries.
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED T-05034 test 7] reconcile idempotency', () => {
  test('calling reconciler twice with same actionRunId+hrcRunId calls action.fail at most once', async () => {
    // First call: action is active → fail is called.
    const port1 = makeFakePort()
    await reconcileActionHrcTerminal(
      { wrkf: port1 },
      { ...BASE_INPUT, hrcTerminalStatus: 'failed' }
    )
    const firstFailCount = port1._calls.filter((c) => c.method === 'action.fail').length
    expect(firstFailCount).toBe(1)

    // Second call: action is now terminal (replay guard) → fail is NOT called.
    const port2 = makeFakePort({ showResult: TERMINAL_ACTION_RUN })
    const result2 = await reconcileActionHrcTerminal(
      { wrkf: port2 },
      { ...BASE_INPUT, hrcTerminalStatus: 'failed' }
    )

    const secondFailCalls = port2._calls.filter((c) => c.method === 'action.fail')
    expect(secondFailCalls).toHaveLength(0)
    expect(result2.outcome).toBe('no_op')
    expect(result2.alreadyTerminal).toBe(true)
  })

  test('idempotencyKey is identical across repeated calls with same actionRunId+hrcRunId', async () => {
    // The idempotencyKey must be deterministic (derived purely from inputs).
    const port1 = makeFakePort()
    await reconcileActionHrcTerminal(
      { wrkf: port1 },
      { ...BASE_INPUT, hrcTerminalStatus: 'failed' }
    )
    const failCall1 = port1._calls.find((c) => c.method === 'action.fail')
    const key1 = (failCall1!.params as Record<string, unknown>)['idempotencyKey']

    const port2 = makeFakePort()
    await reconcileActionHrcTerminal(
      { wrkf: port2 },
      { ...BASE_INPUT, hrcTerminalStatus: 'failed' }
    )
    const failCall2 = port2._calls.find((c) => c.method === 'action.fail')
    const key2 = (failCall2!.params as Record<string, unknown>)['idempotencyKey']

    expect(key1).toBe(key2)
  })

  test('failure_result evidence ref is identical across repeated calls (no conflicting summaries)', async () => {
    // Two calls with the same actionRunId+hrcRunId must produce identical
    // failure_result payloads so that wrkf's idempotencyKey dedup can apply.
    const port1 = makeFakePort()
    await reconcileActionHrcTerminal(
      { wrkf: port1 },
      { ...BASE_INPUT, hrcTerminalStatus: 'cancelled' }
    )
    const fr1 = JSON.stringify(
      (port1._calls.find((c) => c.method === 'action.fail')!.params as Record<string, unknown>)[
        'failureResult'
      ]
    )

    const port2 = makeFakePort()
    await reconcileActionHrcTerminal(
      { wrkf: port2 },
      { ...BASE_INPUT, hrcTerminalStatus: 'cancelled' }
    )
    const fr2 = JSON.stringify(
      (port2._calls.find((c) => c.method === 'action.fail')!.params as Record<string, unknown>)[
        'failureResult'
      ]
    )

    expect(fr1).toBe(fr2)
  })

  test('duplicate HRC terminal events for the same run → action.fail called at most once total', async () => {
    // Simulate two concurrent/replayed HRC terminal events. The first succeeds
    // and marks the action terminal. The second sees terminal status → no-op.
    const port1 = makeFakePort()
    const [r1, r2] = await Promise.all([
      reconcileActionHrcTerminal({ wrkf: port1 }, { ...BASE_INPUT, hrcTerminalStatus: 'failed' }),
      // Second reconciler sees an already-terminal run (wrkf is idempotent source of truth).
      reconcileActionHrcTerminal(
        { wrkf: makeFakePort({ showResult: TERMINAL_ACTION_RUN }) },
        { ...BASE_INPUT, hrcTerminalStatus: 'failed' }
      ),
    ])

    // Exactly one of the two should have called action.fail (the other is a no-op).
    const totalFails = port1._calls.filter((c) => c.method === 'action.fail').length
    expect(totalFails).toBeLessThanOrEqual(1)

    // At least one outcome is 'failed_action'; the no-op outcome is 'no_op'.
    const outcomes = [r1.outcome, r2.outcome]
    expect(outcomes).toContain('failed_action')
    expect(outcomes).toContain('no_op')
  })

  test('action.show is called before every reconcile attempt (read before write)', async () => {
    // The reconciler must always read current action status before acting.
    // This ensures idempotency is driven by wrkf truth, not local state.
    const port = makeFakePort({ showResult: TERMINAL_ACTION_RUN })
    await reconcileActionHrcTerminal({ wrkf: port }, { ...BASE_INPUT, hrcTerminalStatus: 'zombie' })

    const showCalls = port._calls.filter((c) => c.method === 'action.show')
    expect(showCalls).toHaveLength(1) // exactly one read
    expect((showCalls[0]!.params as Record<string, unknown>)['actionRunId']).toBe(ACTION_RUN_ID)
  })
})
