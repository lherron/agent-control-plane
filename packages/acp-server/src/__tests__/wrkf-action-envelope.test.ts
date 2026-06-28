/**
 * RED TESTS — T-05034 (daedalus required tests 1 and 7, launch/envelope side)
 *
 * Test 1 — PROMPT ENVELOPE:
 *   With AND without a caller-supplied initialPrompt, the prompt handed to the
 *   HRC launch (resolveLaunchIntent / launchRoleScopedRun call) must always wrap
 *   caller text inside a protocol envelope that includes:
 *     • actionRunId, wrkfRunId, taskId, action
 *     • HRC binding context when known
 *     • Explicit instructions to call wrkf.action.complete (success) and
 *       wrkf.action.fail (failure) for THIS actionRunId
 *   Caller-supplied initialPrompt is payload APPENDED inside the envelope; it
 *   cannot erase the protocol envelope.
 *
 *   TODAY's bug (line 170 of wrkf/action-launch.ts):
 *     const prompt = input.initialPrompt ?? buildActionPrompt(...)
 *   This lets the caller's initialPrompt REPLACE the generated prompt entirely.
 *   → Tests asserting envelope presence with a caller-supplied prompt FAIL.
 *   → Tests asserting complete/fail instructions FAIL (buildActionPrompt omits them).
 *
 * Test 7 — LAUNCH RETRY IDEMPOTENCY (envelope side):
 *   Repeated launch with the same idempotencyKey does not create a second HRC run
 *   and the envelope content is deterministic (no random data).
 *
 * All tests reference the live launchAction adapter from action-launch.ts.
 * Tests in this file that touch envelope content MUST FAIL today (red bar).
 * Tests that cover idempotency (no double launch) currently pass; the new
 * envelope-idempotency assertion FAILS because the envelope is missing.
 */

import { describe, expect, test } from 'bun:test'

import { formatHrcExternalRef } from 'acp-core'
import type { HrcRuntimeIntent } from 'hrc-core'

import type { LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
import { InMemoryRunStore } from '../domain/run-store.js'
import { launchAction } from '../wrkf/action-launch.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TASK_ID = 'T-09994'
const ACTION = 'implement'
const ROLE = 'implementer'
const IDEMPOTENCY_KEY = 'wrkf-envelope-test-001'
const SESSION_REF = { scopeRef: 'agent:smokey:project:acp-test:task:T-09994', laneRef: 'main' }
const CALLER_INITIAL_PROMPT = 'Implement the reported fix: heap overflow on startup.'

const CANNED_ACTION_RUN = {
  actionRunId: 'actrun-env-aaa111',
  runId: 'actrun-env-aaa111',
  task: TASK_ID,
  instanceId: 'wfi-env-bbb222',
  workflow: { id: 'wrkq-simple-task', version: '1' },
  action: ACTION,
  role: ROLE,
  lane: 'implement',
  status: 'active',
}

// action.start result when the run is already bound — replay, no launch.
const CANNED_ACTION_RUN_BOUND = {
  ...CANNED_ACTION_RUN,
  externalRunRef: 'hrc:hrc-run-already-launched-env-001',
}

const CANNED_LAUNCHED = {
  runId: 'hrc-run-env-001',
  sessionId: 'host-session-env-001',
  hostSessionId: 'host-session-env-001',
  runtimeId: 'runtime-env-001',
  launchId: 'launch-env-001',
  generation: 1,
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type InstrumentedPort = AcpWrkfWorkflowPort & {
  _calls: Array<{ method: string; params: unknown }>
}

function makeFakeWrkfPort(
  overrides: {
    start?: () => Promise<unknown>
    bindExternal?: (params: Record<string, unknown>) => Promise<unknown>
  } = {}
): InstrumentedPort {
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
    },
  } as unknown as InstrumentedPort
}

const FAKE_RUNTIME_RESOLVER: RuntimeResolver = async () => ({
  agentRoot: '/tmp/agents/smokey',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
})

/** Capture the intent from launchRoleScopedRun and return a stable launched result. */
function capturingLauncher(capture: { intent?: HrcRuntimeIntent }): LaunchRoleScopedRun {
  return async (input) => {
    capture.intent = input.intent
    return CANNED_LAUNCHED
  }
}

const BASE_INPUT = {
  taskId: TASK_ID,
  action: ACTION,
  actor: { kind: 'agent' as const, id: 'smokey' },
  idempotencyKey: IDEMPOTENCY_KEY,
  sessionRef: SESSION_REF,
}

// ═════════════════════════════════════════════════════════════════════════════
// Test 1 — prompt envelope without caller initialPrompt
//
// These tests cover the case where no caller prompt is supplied.
// The generated prompt currently (buildActionPrompt) omits explicit
// complete/fail instructions → assertions on those tokens FAIL.
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED T-05034 test 1] prompt envelope — no caller initialPrompt', () => {
  test('launched intent.initialPrompt contains the actionRunId', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}
    const launcher = capturingLauncher(captured)

    await launchAction(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain(CANNED_ACTION_RUN.actionRunId)
  })

  test('launched intent.initialPrompt contains the wrkfRunId (underlying runId)', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      BASE_INPUT
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain(CANNED_ACTION_RUN.runId)
  })

  test('launched intent.initialPrompt contains the taskId', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      BASE_INPUT
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain(TASK_ID)
  })

  test('launched intent.initialPrompt contains the action name', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      BASE_INPUT
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain(ACTION)
  })

  test('[RED] launched prompt includes explicit instruction to call wrkf.action.complete on success', async () => {
    // TODAY: buildActionPrompt omits complete/fail instructions → FAILS.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      BASE_INPUT
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    // The prompt must tell the worker to call wrkf.action.complete with this actionRunId.
    expect(prompt).toContain('wrkf.action.complete')
  })

  test('[RED] launched prompt includes explicit instruction to call wrkf.action.fail on failure', async () => {
    // TODAY: buildActionPrompt omits complete/fail instructions → FAILS.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      BASE_INPUT
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    // The prompt must tell the worker to call wrkf.action.fail on failure.
    expect(prompt).toContain('wrkf.action.fail')
  })

  test('[RED] launched prompt references the specific actionRunId for the complete/fail calls', async () => {
    // The worker must know WHICH actionRunId to complete/fail.
    // buildActionPrompt includes the actionRun blob (so actionRunId is present),
    // but it does NOT include a targeted protocol instruction linking the
    // actionRunId to the complete/fail calls → the test checks for both tokens
    // together (actionRunId + complete/fail reference).
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      BASE_INPUT
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    // Both actionRunId and the protocol instruction must coexist.
    expect(prompt).toContain(CANNED_ACTION_RUN.actionRunId)
    expect(prompt).toContain('wrkf.action.complete')
    expect(prompt).toContain('wrkf.action.fail')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test 1 — prompt envelope WITH caller initialPrompt
//
// The caller supplies an initialPrompt. Today the adapter does:
//   const prompt = input.initialPrompt ?? buildActionPrompt(...)
// so the caller's text REPLACES the envelope entirely.
//
// After the fix, the caller text must be APPENDED inside the protocol envelope
// and the envelope must always be present regardless of caller text.
// These tests FAIL today because the envelope is replaced.
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED T-05034 test 1] prompt envelope — WITH caller initialPrompt', () => {
  test('[RED] caller text is present in the launched prompt', async () => {
    // This PASSES today (caller text is used as-is), but combined with the
    // envelope-presence assertions below it forms the full contract.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, initialPrompt: CALLER_INITIAL_PROMPT }
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain(CALLER_INITIAL_PROMPT)
  })

  test('[RED] actionRunId still present in prompt even when caller supplies initialPrompt', async () => {
    // TODAY: caller's initialPrompt replaces the envelope → actionRunId absent → FAILS.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, initialPrompt: CALLER_INITIAL_PROMPT }
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain(CANNED_ACTION_RUN.actionRunId)
  })

  test('[RED] taskId still present in prompt even when caller supplies initialPrompt', async () => {
    // TODAY: caller prompt replaces the envelope → taskId absent → FAILS.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, initialPrompt: CALLER_INITIAL_PROMPT }
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain(TASK_ID)
  })

  test('[RED] wrkf.action.complete instruction present even when caller supplies initialPrompt', async () => {
    // TODAY: caller prompt replaces the envelope entirely → FAILS.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, initialPrompt: CALLER_INITIAL_PROMPT }
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain('wrkf.action.complete')
  })

  test('[RED] wrkf.action.fail instruction present even when caller supplies initialPrompt', async () => {
    // TODAY: caller prompt replaces the envelope entirely → FAILS.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, initialPrompt: CALLER_INITIAL_PROMPT }
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain('wrkf.action.fail')
  })

  test('[RED] caller text does not REPLACE the envelope: prompt is not equal to caller text alone', async () => {
    // TODAY: prompt === initialPrompt (caller text IS the entire prompt) → FAILS.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, initialPrompt: CALLER_INITIAL_PROMPT }
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    // The prompt must be LONGER than the caller text alone (envelope wraps it).
    expect(prompt).not.toBe(CALLER_INITIAL_PROMPT)
    expect(prompt.length).toBeGreaterThan(CALLER_INITIAL_PROMPT.length)
  })

  test('[RED] envelope and caller text coexist: all protocol fields + caller text present together', async () => {
    // Compound assertion: every required envelope field plus the caller payload
    // must appear in a single prompt string. TODAY this FAILS.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, initialPrompt: CALLER_INITIAL_PROMPT }
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    expect(prompt).toContain(CANNED_ACTION_RUN.actionRunId)
    expect(prompt).toContain(CANNED_ACTION_RUN.runId) // wrkfRunId
    expect(prompt).toContain(TASK_ID)
    expect(prompt).toContain(ACTION)
    expect(prompt).toContain('wrkf.action.complete')
    expect(prompt).toContain('wrkf.action.fail')
    expect(prompt).toContain(CALLER_INITIAL_PROMPT)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test 1 — HRC binding context in envelope (when known at crash-window re-bind)
//
// If the adapter is in crash-window recovery mode (hrcRunId already committed),
// the envelope should reference the bound hrc:<runId>. The crash-window path
// does NOT re-launch HRC (it re-binds only), but IF a prompt IS built, the
// hrc ref should appear.
//
// This test is structural: it verifies that a fresh-launch envelope WILL include
// the hrcRunId once the HRC launch result is known. Because the prompt is built
// BEFORE the launch result is available, the implementation must include the
// expected ref format or a placeholder. Today the prompt doesn't mention hrc refs.
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED T-05034 test 1] prompt envelope — HRC binding context', () => {
  test('[RED] launched prompt references the expected hrc:<runId> external ref format', async () => {
    // The envelope must tell the worker what external ref format is used so it
    // can include it in failure_result if needed. Today no hrc ref appears.
    // NOTE: the hrcRunId is NOT known before launch; the impl must include either
    // a protocol note about the hrc: scheme or a format hint.
    // We accept: the launched prompt contains 'hrc:' as a prefix hint.
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      BASE_INPUT
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    // Envelope should mention the hrc: ref format or the actionRunId binding context.
    expect(prompt).toContain('hrc:')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// Test 7 — Launch retry idempotency: envelope content is deterministic
//
// If the same launchAction call is retried (e.g. after a crash), the envelope
// content must be deterministic (same output for same inputs). Today the
// buildActionPrompt function IS deterministic, but:
//   • It does not include complete/fail instructions (test 1 FAILS), and
//   • When a caller initialPrompt is supplied it replaces the envelope (test 1 FAILS).
// The test below checks that the ENVELOPE ITSELF is deterministic across two
// equivalent fresh launches. It FAILS because the envelope is missing (today,
// the prompt is either the caller text alone or a non-envelope buildActionPrompt).
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED T-05034 test 7] launch envelope idempotency', () => {
  test('[RED] two identical launch calls (same input) produce identical envelope content', async () => {
    // Two launchAction calls with distinct run stores (simulating two retries
    // that each launch fresh). Both should produce the same envelope.
    const captured1: { intent?: HrcRuntimeIntent } = {}
    const captured2: { intent?: HrcRuntimeIntent } = {}

    const wrkf1 = makeFakeWrkfPort()
    await launchAction(
      {
        wrkf: wrkf1,
        runStore: new InMemoryRunStore(),
        launchRoleScopedRun: capturingLauncher(captured1),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, idempotencyKey: 'wrkf-idem-a-001' }
    )

    const wrkf2 = makeFakeWrkfPort()
    await launchAction(
      {
        wrkf: wrkf2,
        runStore: new InMemoryRunStore(),
        launchRoleScopedRun: capturingLauncher(captured2),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, idempotencyKey: 'wrkf-idem-a-001' }
    )

    const prompt1 = captured1.intent?.initialPrompt ?? ''
    const prompt2 = captured2.intent?.initialPrompt ?? ''

    // Both prompts must contain the full protocol envelope (not just a stub).
    expect(prompt1).toContain('wrkf.action.complete')
    expect(prompt1).toContain('wrkf.action.fail')
    expect(prompt2).toContain('wrkf.action.complete')
    expect(prompt2).toContain('wrkf.action.fail')

    // They must be identical (deterministic from inputs).
    expect(prompt1).toBe(prompt2)
  })

  test('[RED] repeated launch with same idempotencyKey and caller initialPrompt → envelope + caller text in both', async () => {
    // Both retried calls must produce envelopes that wrap the caller text.
    const captured1: { intent?: HrcRuntimeIntent } = {}
    const captured2: { intent?: HrcRuntimeIntent } = {}

    const wrkf1 = makeFakeWrkfPort()
    await launchAction(
      {
        wrkf: wrkf1,
        runStore: new InMemoryRunStore(),
        launchRoleScopedRun: capturingLauncher(captured1),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, idempotencyKey: 'wrkf-idem-b-001', initialPrompt: CALLER_INITIAL_PROMPT }
    )

    const wrkf2 = makeFakeWrkfPort()
    await launchAction(
      {
        wrkf: wrkf2,
        runStore: new InMemoryRunStore(),
        launchRoleScopedRun: capturingLauncher(captured2),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, idempotencyKey: 'wrkf-idem-b-001', initialPrompt: CALLER_INITIAL_PROMPT }
    )

    const prompt1 = captured1.intent?.initialPrompt ?? ''
    const prompt2 = captured2.intent?.initialPrompt ?? ''

    // Each prompt must contain the full envelope AND the caller text.
    for (const prompt of [prompt1, prompt2]) {
      expect(prompt).toContain('wrkf.action.complete')
      expect(prompt).toContain('wrkf.action.fail')
      expect(prompt).toContain(CANNED_ACTION_RUN.actionRunId)
      expect(prompt).toContain(CALLER_INITIAL_PROMPT)
    }

    // Both must be identical.
    expect(prompt1).toBe(prompt2)
  })

  test('replay via wrkf-bound action run skips launch (no second prompt built)', async () => {
    // Existing behavior (GREEN): if action.start returns an already-bound run,
    // no HRC launch occurs, so no prompt is built. This test stays GREEN.
    const wrkf = makeFakeWrkfPort({ start: async () => CANNED_ACTION_RUN_BOUND })
    const runStore = new InMemoryRunStore()
    let launchCalled = false
    const launcher: LaunchRoleScopedRun = async () => {
      launchCalled = true
      return CANNED_LAUNCHED
    }

    const result = await launchAction(
      { wrkf, runStore, launchRoleScopedRun: launcher, runtimeResolver: FAKE_RUNTIME_RESOLVER },
      BASE_INPUT
    )

    expect(result.replay).toBe(true)
    expect(launchCalled).toBe(false)
  })

  test('[RED] envelope contains the hrc: external ref format hint in repeat launches too', async () => {
    const wrkf = makeFakeWrkfPort()
    const runStore = new InMemoryRunStore()
    const captured: { intent?: HrcRuntimeIntent } = {}

    await launchAction(
      {
        wrkf,
        runStore,
        launchRoleScopedRun: capturingLauncher(captured),
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      },
      { ...BASE_INPUT, idempotencyKey: 'wrkf-idem-hrc-001' }
    )

    const prompt = captured.intent?.initialPrompt ?? ''
    // Envelope includes hrc: format so worker knows the ref scheme.
    expect(prompt).toContain('hrc:')
    // No random content: the envelope is stable / deterministic.
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(50)
  })
})

// ─── Regression guard ────────────────────────────────────────────────────────
// Existing adapter behaviors that must NOT regress. These are currently GREEN.

describe('[GREEN regression] existing adapter behaviors — must not regress', () => {
  test('happy path still returns correct ids (non-envelope behaviors unchanged)', async () => {
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
  })

  test('action.bindExternal is called with hrc:<id> ref and actionRunId', async () => {
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
  })
})
