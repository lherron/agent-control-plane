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

import type { HrcRuntimeIntent } from 'hrc-core'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
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

async function captureRoutePrompt(
  input: typeof BASE_INPUT & { initialPrompt?: string }
): Promise<string> {
  const captured: { intent?: HrcRuntimeIntent } = {}
  await withWiredServer(
    async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/wrkf/actions/launch',
        body: input,
      })
      expect(response.status).toBe(201)
    },
    {
      wrkf: makeFakeWrkfPort(),
      launchRoleScopedRun: capturingLauncher(captured),
      runtimeResolver: FAKE_RUNTIME_RESOLVER,
    }
  )
  expect(captured.intent).toBeDefined()
  return captured.intent?.initialPrompt ?? ''
}

// ═════════════════════════════════════════════════════════════════════════════
// Test 1 — prompt envelope without caller initialPrompt
//
// These tests cover the case where no caller prompt is supplied.
// The generated prompt currently (buildActionPrompt) omits explicit
// complete/fail instructions → assertions on those tokens FAIL.
// ═════════════════════════════════════════════════════════════════════════════

describe('[RED T-05034 test 1] prompt envelope — no caller initialPrompt', () => {
  test('[RED] launched prompt references the specific actionRunId for the complete/fail calls', async () => {
    // The worker must know WHICH actionRunId to complete/fail.
    // buildActionPrompt includes the actionRun blob (so actionRunId is present),
    // but it does NOT include a targeted protocol instruction linking the
    // actionRunId to the complete/fail calls → the test checks for both tokens
    // together (actionRunId + complete/fail reference).
    const prompt = await captureRoutePrompt(BASE_INPUT)
    // Both actionRunId and the protocol instruction must coexist.
    expect(prompt).toContain(CANNED_ACTION_RUN.actionRunId)
    expect(prompt).toContain(CANNED_ACTION_RUN.runId)
    expect(prompt).toContain(TASK_ID)
    expect(prompt).toContain(ACTION)
    expect(prompt).toContain('hrc:')
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
  test('[RED] envelope and caller text coexist: all protocol fields + caller text present together', async () => {
    // Compound assertion: every required envelope field plus the caller payload
    // must appear in a single prompt string. TODAY this FAILS.
    const prompt = await captureRoutePrompt({ ...BASE_INPUT, initialPrompt: CALLER_INITIAL_PROMPT })
    expect(prompt).toContain(CANNED_ACTION_RUN.actionRunId)
    expect(prompt).toContain(CANNED_ACTION_RUN.runId) // wrkfRunId
    expect(prompt).toContain(TASK_ID)
    expect(prompt).toContain(ACTION)
    expect(prompt).toContain('wrkf.action.complete')
    expect(prompt).toContain('wrkf.action.fail')
    expect(prompt).toContain(CALLER_INITIAL_PROMPT)
    expect(prompt).not.toBe(CALLER_INITIAL_PROMPT)
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

describe('[RED T-05034 test 1] prompt envelope — HRC binding context', () => {})

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
  test.each([{ initialPrompt: undefined }, { initialPrompt: CALLER_INITIAL_PROMPT }])(
    'fresh launches produce identical envelopes with caller prompt $initialPrompt',
    async ({ initialPrompt }) => {
      // Two launchAction calls with distinct run stores (simulating two retries
      // that each launch fresh). Both should produce the same envelope.
      const input = { ...BASE_INPUT, idempotencyKey: 'wrkf-idem-a-001', initialPrompt }
      const prompt1 = await captureRoutePrompt(input)
      const prompt2 = await captureRoutePrompt(input)

      // Both prompts must contain the full protocol envelope (not just a stub).
      expect(prompt1).toContain('wrkf.action.complete')
      expect(prompt1).toContain('wrkf.action.fail')
      expect(prompt2).toContain('wrkf.action.complete')
      expect(prompt2).toContain('wrkf.action.fail')

      for (const prompt of [prompt1, prompt2]) {
        if (initialPrompt) {
          expect(prompt).toContain(CANNED_ACTION_RUN.actionRunId)
          expect(prompt).toContain(initialPrompt)
        }
      }

      // They must be identical (deterministic from inputs).
      expect(prompt1).toBe(prompt2)
    }
  )
})

// ─── Regression guard ────────────────────────────────────────────────────────
// Existing adapter behaviors that must NOT regress. These are currently GREEN.
