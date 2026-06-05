/**
 * RED TESTS — W4b: participant-run routes rebuilt over wrkf (T-01934)
 *
 * Why red:
 *   1. POST /v1/workflow-participant-runs: current handler (handleCreateWorkflowParticipantRun)
 *      uses withDurableWorkflowKernel regardless of deps.wrkf. With deps.wrkf injected
 *      the kernel still runs; it returns a non-wrkf response shape (missing source:'wrkf',
 *      wrkfRun, replay). Status will be 422 (kernel can't find task in workflow runtime),
 *      not 201 with the required wrkf-projection shape.
 *   2. POST /:runId/complete: current handler calls kernel.completeParticipantRun, not
 *      deps.wrkf.run.finish. Test expects 200 + {source:'wrkf'} and wrkf.run.finish to
 *      be called; current handler returns 422 (run not in kernel state).
 *   3. POST /:runId/fail: same; current handler calls kernel.failParticipantRun, not
 *      deps.wrkf.run.fail.
 *   4. Guards: current handlers do not return 503 WRKF_UNAVAILABLE when deps.wrkf is absent;
 *      they fall through to kernel → different error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPL CONTRACT — what must change in workflow-participant-runs.ts to go green:
 *
 *   handleCreateWorkflowParticipantRun:
 *     1. if deps.wrkf === undefined → 503 WRKF_UNAVAILABLE
 *     2. Parse: {taskId, role, actor?, idempotencyKey, sessionRef?, initialPrompt?}
 *     3. If sessionRef absent → construct default from taskId+role (or 503/422)
 *     4. Call launchParticipant(deps, {taskId, role, actor, idempotencyKey, sessionRef, initialPrompt})
 *        where launchParticipant is from packages/acp-server/src/wrkf/participant-launch.ts
 *     5. Return json(result, result.replay ? 200 : 201)
 *        (201 on new launch, 200 on replay)
 *     NOTE: do NOT return ACP participant-run objects; wrkfRun IS the run
 *
 *   handleCompleteWorkflowParticipantRun:
 *     1. if deps.wrkf === undefined → 503 WRKF_UNAVAILABLE
 *     2. runId comes from params (it is a WRKF run id, e.g. "wrkfrun-bbb222")
 *     3. Parse: {summary}  — NO outcome, NO evidenceRefs, NO idempotencyKey
 *     4. result = await deps.wrkf.run.finish({runId, status: 'completed', summary})
 *        Note: run.finish has no idempotencyKey; returned Run serializes summary as terminalResult
 *     5. Return json({source: 'wrkf', run: result}, 200)
 *
 *   handleFailWorkflowParticipantRun:
 *     1. if deps.wrkf === undefined → 503 WRKF_UNAVAILABLE
 *     2. runId comes from params (WRKF run id)
 *     3. Parse: {reason, classification?}
 *     4. Fold reason+classification into summary string
 *     5. result = await deps.wrkf.run.fail({runId, summary})
 *     6. Return json({source: 'wrkf', run: result}, 200)
 *     7. Same payload → replay (wrkf handles idempotency); conflicting payload → 409
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { LaunchRoleScopedRun, RuntimeResolver } from '../deps.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

// ─── Shared fixture data ─────────────────────────────────────────────────────

const TASK_ID = 'T-09992'
const ROLE = 'implementer'
const WRKF_RUN_ID = 'wrkfrun-ccc333'

const CANNED_TASK = { taskId: TASK_ID, projectId: 'P-001', status: 'open', version: 2 }
const CANNED_INSTANCE = {
  instanceId: 'inst-ddd444',
  workflowRef: 'canonical-flow@v1',
  revision: 3,
  phase: 'in_progress',
}
const CANNED_NEXT = { transitions: [{ id: 'complete', label: 'Complete' }] }
const CANNED_WRKF_RUN = {
  id: WRKF_RUN_ID,
  taskId: TASK_ID,
  role: ROLE,
  state: 'active',
}
const CANNED_WRKF_RUN_BOUND = {
  ...CANNED_WRKF_RUN,
  externalRunRef: 'hrc-run-already-bound-001',
}
const CANNED_LAUNCHED = {
  runId: 'hrc-run-route-001',
  sessionId: 'host-session-route-001',
  hostSessionId: 'host-session-route-001',
  runtimeId: 'runtime-route-001',
  launchId: 'launch-route-001',
  generation: 1,
}
const CANNED_FINISH_RESULT = {
  id: WRKF_RUN_ID,
  state: 'completed',
  terminalResult: 'route complete summary',
}
const CANNED_FAIL_RESULT = {
  id: WRKF_RUN_ID,
  state: 'failed',
  terminalResult: 'route fail reason',
}

class WrkfError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WrkfError'
  }
}

// ─── Fake port builder ───────────────────────────────────────────────────────

type FakeWrkfOverrides = {
  runStart?: () => Promise<unknown>
  bindExternal?: (params: Record<string, unknown>) => Promise<unknown>
  finish?: (params: Record<string, unknown>) => Promise<unknown>
  fail?: (params: Record<string, unknown>) => Promise<unknown>
}

function makeFakeWrkfPort(overrides: FakeWrkfOverrides = {}): AcpWrkfWorkflowPort & {
  _calls: Array<{ method: string; params: unknown }>
} {
  const _calls: Array<{ method: string; params: unknown }> = []
  const boom = (name: string) => (): never => {
    throw new Error(`fake wrkf: ${name} must not be called`)
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
      finish: async (params) => {
        _calls.push({ method: 'run.finish', params })
        if (overrides.finish !== undefined) {
          return overrides.finish(params as Record<string, unknown>)
        }
        return CANNED_FINISH_RESULT
      },
      fail: async (params) => {
        _calls.push({ method: 'run.fail', params })
        if (overrides.fail !== undefined) {
          return overrides.fail(params as Record<string, unknown>)
        }
        return CANNED_FAIL_RESULT
      },
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
  } as AcpWrkfWorkflowPort & { _calls: Array<{ method: string; params: unknown }> }
}

const FAKE_RUNTIME_RESOLVER: RuntimeResolver = async () => ({
  agentRoot: '/tmp/agents/larry',
  projectRoot: '/tmp/project',
  cwd: '/tmp/project',
  runMode: 'task',
  bundle: { kind: 'compose', compose: [] },
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/workflow-participant-runs
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/workflow-participant-runs — wrkf source-tagged response (W4b red)', () => {
  // RED: current handler uses withDurableWorkflowKernel → kernel path → returns old shape or 422.
  // After impl: handler delegates to launchParticipant → returns {source:'wrkf',...}.

  test('[RED] returns 201 with source:"wrkf" on successful launch', async () => {
    const wrkf = makeFakeWrkfPort()
    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-participant-runs',
          body: {
            taskId: TASK_ID,
            role: ROLE,
            actor: { kind: 'agent', id: 'larry' },
            idempotencyKey: 'route-test-launch-001',
            sessionRef: 'agent:larry:project:acps-test:task:T-09992~main',
          },
        })

        // RED: current handler returns 422 (kernel path) or old shape; new handler must return 201+wrkf shape
        expect(response.status).toBe(201)
        const body = await fixture.json<{
          source: string
          taskId: string
          instanceId: string
          workflowRef: string
          revision: number
          wrkfRun: Record<string, unknown>
          launch: unknown
          replay: boolean
        }>(response)

        expect(body.source).toBe('wrkf')
        expect(body.taskId).toBe(TASK_ID)
        expect(body.instanceId).toBe(CANNED_INSTANCE.instanceId)
        expect(body.workflowRef).toBe(CANNED_INSTANCE.workflowRef)
        expect(body.revision).toBe(CANNED_INSTANCE.revision)
        expect(body.wrkfRun).toBeDefined()
        expect(body.launch).toBeDefined()
        expect(body.replay).toBe(false)
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })

  test('[RED] returns 200 (not 201) on replay when wrkf run already has externalRunRef', async () => {
    const wrkf = makeFakeWrkfPort({
      runStart: async () => CANNED_WRKF_RUN_BOUND,
    })
    const launchCalls: unknown[] = []
    const launcher: LaunchRoleScopedRun = async (input) => {
      launchCalls.push(input)
      return CANNED_LAUNCHED
    }

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-participant-runs',
          body: {
            taskId: TASK_ID,
            role: ROLE,
            idempotencyKey: 'route-test-replay-001',
            sessionRef: 'agent:larry:project:acps-test:task:T-09992~main',
          },
        })

        // RED: returns 422 (kernel path), not 200 with replay:true
        expect(response.status).toBe(200)
        const body = await fixture.json<{ source: string; replay: boolean }>(response)
        expect(body.source).toBe('wrkf')
        expect(body.replay).toBe(true)
        expect(launchCalls).toHaveLength(0)
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })

  test('[RED] response must NOT contain ACP participant-run objects (participantRun, context fields)', async () => {
    // wrkfRun IS the run; no ACP participant-run object should be returned
    const wrkf = makeFakeWrkfPort()
    const launcher: LaunchRoleScopedRun = async () => CANNED_LAUNCHED

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-participant-runs',
          body: {
            taskId: TASK_ID,
            role: ROLE,
            idempotencyKey: 'route-test-no-acp-001',
            sessionRef: 'agent:larry:project:acps-test:task:T-09992~main',
          },
        })

        expect(response.status).toBe(201)
        const body = await fixture.json<Record<string, unknown>>(response)
        // ACP participant-run objects must not be present in the response
        expect(body['participantRun']).toBeUndefined()
        expect(body['context']).toBeUndefined()
        expect(body['workflowHrcRunMap']).toBeUndefined()
        expect(body['ok']).toBeUndefined()
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is not configured', async () => {
    // Current handler ignores deps.wrkf and falls through to kernel → wrong error
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/workflow-participant-runs',
        body: {
          taskId: TASK_ID,
          role: ROLE,
          idempotencyKey: 'route-test-no-wrkf-001',
          sessionRef: 'agent:larry:project:acps-test:task:T-09992~main',
        },
      })
      // RED: current handler does not check deps.wrkf → returns 422 from kernel path
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
    // withWiredServer called without wrkf override → deps.wrkf is undefined
  })

  test('blocked launch claim retry returns HTTP 409 with WRKF_PARTICIPANT_LAUNCH_BLOCKED', async () => {
    const wrkf = makeFakeWrkfPort()
    let launchCount = 0
    const launcher: LaunchRoleScopedRun = async () => {
      launchCount++
      throw new Error('HRC accepted run but acknowledgement was lost')
    }

    await withWiredServer(
      async (fixture) => {
        const body = {
          taskId: TASK_ID,
          role: ROLE,
          idempotencyKey: 'route-test-blocked-launch-001',
          sessionRef: 'agent:larry:project:acps-test:task:T-09992~main',
        }

        const first = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-participant-runs',
          body,
        })
        expect(first.status).toBe(500)

        const retry = await fixture.request({
          method: 'POST',
          path: '/v1/workflow-participant-runs',
          body,
        })
        expect(retry.status).toBe(409)
        const retryBody = await fixture.json<{ error: { code: string } }>(retry)
        expect(retryBody.error.code).toBe('WRKF_PARTICIPANT_LAUNCH_BLOCKED')
        expect(launchCount).toBe(1)
      },
      {
        wrkf,
        launchRoleScopedRun: launcher,
        runtimeResolver: FAKE_RUNTIME_RESOLVER,
      }
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/workflow-participant-runs/:runId/complete
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/workflow-participant-runs/:runId/complete — wrkf.run.finish (W4b red)', () => {
  // RED: current handler calls kernel.completeParticipantRun.
  // After impl: handler must call deps.wrkf.run.finish({runId, status:'completed', summary}).

  test('[RED] calls deps.wrkf.run.finish with runId and summary', async () => {
    const wrkf = makeFakeWrkfPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/workflow-participant-runs/${WRKF_RUN_ID}/complete`,
          body: {
            summary: 'implementation done',
          },
        })

        // RED: current handler calls kernel → 422 (run not in kernel state)
        expect(response.status).toBe(200)

        const finishCall = wrkf._calls.find((c) => c.method === 'run.finish')
        expect(finishCall).toBeDefined()
        const p = finishCall!.params as Record<string, unknown>
        expect(p['runId']).toBe(WRKF_RUN_ID)
        expect(p['status']).toBe('completed')
        expect(p['summary']).toBe('implementation done')
      },
      { wrkf }
    )
  })

  test('[RED] returns {source:"wrkf", run: ...} response shape', async () => {
    const wrkf = makeFakeWrkfPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/workflow-participant-runs/${WRKF_RUN_ID}/complete`,
          body: {
            summary: 'implementation done',
          },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<{ source: string; run: Record<string, unknown> }>(response)
        // RED: current handler returns kernel-style response without source:'wrkf'
        expect(body.source).toBe('wrkf')
        expect(body.run).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] complete handler does NOT accept outcome, evidenceRefs, or idempotencyKey fields (wrkf.run.finish has no such params)', async () => {
    // wrkf.run.finish signature: {runId, status, summary}
    // Old kernel handler accepted outcome/evidenceRefs/idempotencyKey — new one must not forward them.
    const wrkf = makeFakeWrkfPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/workflow-participant-runs/${WRKF_RUN_ID}/complete`,
          body: {
            summary: 'implementation done',
            outcome: 'success', // old kernel field — must be ignored
            evidenceRefs: ['artifact://x'], // old kernel field — must be ignored
            idempotencyKey: 'key-complete', // old kernel field — must be ignored
          },
        })

        // Request should succeed (extra fields ignored or stripped)
        expect(response.status).toBe(200)
        const finishCall = wrkf._calls.find((c) => c.method === 'run.finish')
        expect(finishCall).toBeDefined()
        const p = finishCall!.params as Record<string, unknown>
        // Only runId, status, summary should be forwarded; old fields silently ignored
        expect(p['outcome']).toBeUndefined()
        expect(p['evidenceRefs']).toBeUndefined()
        expect(p['idempotencyKey']).toBeUndefined()
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is not configured', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/workflow-participant-runs/${WRKF_RUN_ID}/complete`,
        body: { summary: 'done' },
      })
      // RED: current handler uses kernel → different error
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /v1/workflow-participant-runs/:runId/fail
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /v1/workflow-participant-runs/:runId/fail — wrkf.run.fail (W4b red)', () => {
  // RED: current handler calls kernel.failParticipantRun.
  // After impl: handler must call deps.wrkf.run.fail({runId, summary}).

  test('[RED] calls deps.wrkf.run.fail with runId and folded summary', async () => {
    const wrkf = makeFakeWrkfPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/workflow-participant-runs/${WRKF_RUN_ID}/fail`,
          body: {
            reason: 'implementation stalled',
            classification: 'participant_repeated_failure',
          },
        })

        // RED: current handler calls kernel → 422 (run not in kernel state)
        expect(response.status).toBe(200)

        const failCall = wrkf._calls.find((c) => c.method === 'run.fail')
        expect(failCall).toBeDefined()
        const p = failCall!.params as Record<string, unknown>
        expect(p['runId']).toBe(WRKF_RUN_ID)
        // reason + classification folded into summary
        const summary = p['summary'] as string
        expect(summary).toContain('implementation stalled')
        expect(summary).toContain('participant_repeated_failure')
      },
      { wrkf }
    )
  })

  test('[RED] fail handler with reason only (no classification) still calls run.fail', async () => {
    const wrkf = makeFakeWrkfPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/workflow-participant-runs/${WRKF_RUN_ID}/fail`,
          body: {
            reason: 'agent crashed',
          },
        })

        expect(response.status).toBe(200)
        const failCall = wrkf._calls.find((c) => c.method === 'run.fail')
        expect(failCall).toBeDefined()
        const p = failCall!.params as Record<string, unknown>
        expect(p['runId']).toBe(WRKF_RUN_ID)
        expect(p['summary']).toContain('agent crashed')
      },
      { wrkf }
    )
  })

  test('[RED] returns {source:"wrkf", run: ...} response shape', async () => {
    const wrkf = makeFakeWrkfPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/workflow-participant-runs/${WRKF_RUN_ID}/fail`,
          body: { reason: 'agent crashed' },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<{ source: string; run: Record<string, unknown> }>(response)
        // RED: current handler returns kernel-style response without source:'wrkf'
        expect(body.source).toBe('wrkf')
        expect(body.run).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] conflicting fail payload → wrkf.run.fail throws → 409', async () => {
    // wrkf handles idempotency: same payload → replay; conflicting → throws WRKF_IDEMPOTENCY_MISMATCH.
    // The route handler must map WRKF_IDEMPOTENCY_MISMATCH to HTTP 409.
    const wrkf = makeFakeWrkfPort({
      fail: async () => {
        throw new WrkfError('WRKF_IDEMPOTENCY_MISMATCH', 'conflicting fail payload for same run')
      },
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/workflow-participant-runs/${WRKF_RUN_ID}/fail`,
          body: { reason: 'conflicting reason' },
        })

        // RED: current handler uses kernel path → returns 422, not 409
        expect(response.status).toBe(409)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_IDEMPOTENCY_MISMATCH')
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is not configured', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/workflow-participant-runs/${WRKF_RUN_ID}/fail`,
        body: { reason: 'crash' },
      })
      // RED: current handler uses kernel → different error
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Route: runId is a WRKF run id, not an ACP run id
// ─────────────────────────────────────────────────────────────────────────────

describe('runId semantics — WRKF run ids (W4b red)', () => {
  test('[RED] complete handler passes wrkf run id verbatim to wrkf.run.finish (not an ACP run_wrkf_* id)', async () => {
    // The :runId param is a wrkf run id like "wrkfrun-bbb222".
    // The handler must pass it directly to wrkf.run.finish.
    // It must NOT construct a "run_wrkf_*" ACP correlation id.
    const wrkf = makeFakeWrkfPort()
    const CUSTOM_WRKF_RUN_ID = 'wrkfrun-custom-xyz789'

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/workflow-participant-runs/${CUSTOM_WRKF_RUN_ID}/complete`,
          body: { summary: 'done' },
        })

        expect(response.status).toBe(200)
        const finishCall = wrkf._calls.find((c) => c.method === 'run.finish')
        expect(finishCall).toBeDefined()
        const p = finishCall!.params as Record<string, unknown>
        expect(p['runId']).toBe(CUSTOM_WRKF_RUN_ID)
        expect(p['runId']).not.toContain('run_wrkf_') // must not be ACP-wrapped
      },
      { wrkf }
    )
  })

  test('[RED] fail handler passes wrkf run id verbatim to wrkf.run.fail', async () => {
    const wrkf = makeFakeWrkfPort()
    const CUSTOM_WRKF_RUN_ID = 'wrkfrun-custom-abc123'

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/workflow-participant-runs/${CUSTOM_WRKF_RUN_ID}/fail`,
          body: { reason: 'crash' },
        })

        expect(response.status).toBe(200)
        const failCall = wrkf._calls.find((c) => c.method === 'run.fail')
        expect(failCall).toBeDefined()
        const p = failCall!.params as Record<string, unknown>
        expect(p['runId']).toBe(CUSTOM_WRKF_RUN_ID)
        expect(p['runId']).not.toContain('run_wrkf_')
      },
      { wrkf }
    )
  })
})
