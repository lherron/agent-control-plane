/**
 * RED TESTS — W2a: handleGetWorkflowTask rebuilt as source-tagged wrkf projection
 *
 * Why red now: handleGetWorkflowTask still uses withDurableWorkflowKernel (old kernel path).
 * The fake deps.wrkf injected here is never called by the current handler.
 * All tests below fail until the impl agent rewrites the handler.
 *
 * What the impl agent must change to make these green:
 *
 *   In packages/acp-server/src/handlers/workflow-tasks.ts:
 *
 *   1. Guard: if deps.wrkf === undefined, throw AcpHttpError(503, 'WRKF_UNAVAILABLE', 'wrkf port not available')
 *
 *   2. Replace withDurableWorkflowKernel with parallel/sequential wrkf calls:
 *        const inspected   = await deps.wrkf.task.inspect({ task: taskId })
 *        const timeline    = await deps.wrkf.task.timeline({ task: taskId })
 *        const next        = await deps.wrkf.next({ task: taskId })
 *        const evidence    = await deps.wrkf.evidence.list({ task: taskId })
 *        const obligations = await deps.wrkf.obligation.list({ task: taskId })
 *        const effects     = await deps.wrkf.effect.list({ task: taskId })
 *        const runs        = await deps.wrkf.run.list({ task: taskId })
 *      where task.inspect returns { task, instance }.
 *
 *   3. Return: json({ source: 'wrkf', task, instance, next, timeline, evidence, obligations, effects, runs })
 *
 *   4. Catch wrkf errors (any thrown value with a .code string property):
 *        import { wrkfErrorToHttpStatus } from '../wrkf/errors.js'
 *        // in catch: throw new AcpHttpError(wrkfErrorToHttpStatus(e.code), e.code, e.message)
 *
 *   5. Remove the `withDurableWorkflowKernel` import — handleGetWorkflowTask must not
 *      use it. (Other handlers in the same file may keep using it for now.)
 *      IMPORTANT: only remove it from the import if no other export in workflow-tasks.ts
 *      still uses it; if other handlers still use it, keep the import and just remove
 *      the call from handleGetWorkflowTask itself.
 *      The source-code assertion (test 5) checks for the *call* pattern, not the import:
 *      it asserts handleGetWorkflowTask does not delegate to withDurableWorkflowKernel.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, test } from 'bun:test'

import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

// ── Canned fixture data returned by the fake wrkf port ───────────────────────

const TASK_ID = 'T-WRKF001'

const CANNED_TASK = { taskId: TASK_ID, projectId: 'P-001', status: 'open', version: 3 }
const CANNED_INSTANCE = { instanceId: 'I-001', workflowId: 'basic', phase: 'todo' }
const CANNED_NEXT = { transitions: [{ id: 'start', label: 'Start' }] }
const CANNED_TIMELINE = [{ type: 'task.created', occurredAt: '2026-06-05T00:00:00Z' }]
const CANNED_EVIDENCE = [{ id: 'E-001', kind: 'manual', ref: 'ref://test' }]
const CANNED_OBLIGATIONS = [{ id: 'OB-001', role: 'owner', kind: 'review' }]
const CANNED_EFFECTS = [{ id: 'EF-001', kind: 'wake_role_session', state: 'delivered' }]
const CANNED_RUNS = [{ id: 'R-001', role: 'owner', state: 'completed' }]

// ── Error class thrown by the fake wrkf port to simulate domain errors ────────

class WrkfError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'WrkfError'
  }
}

// ── Fake port factory ─────────────────────────────────────────────────────────

type FakePortOverrides = {
  /** If set, task.inspect throws this error instead of returning canned data */
  inspectError?: Error | undefined
}

function makeFakeWrkfPort(overrides: FakePortOverrides = {}): AcpWrkfWorkflowPort {
  const notCalled = (name: string) => (): never => {
    throw new Error(`fake AcpWrkfWorkflowPort: ${name} must not be called in this test`)
  }
  return {
    workflow: {
      validate: notCalled('workflow.validate'),
      show: notCalled('workflow.show'),
      list: notCalled('workflow.list'),
      diff: notCalled('workflow.diff'),
      install: notCalled('workflow.install'),
    },
    task: {
      attach: notCalled('task.attach'),
      inspect: async (_params) => {
        if (overrides.inspectError !== undefined) throw overrides.inspectError
        return { task: CANNED_TASK, instance: CANNED_INSTANCE }
      },
      timeline: async (_params) => CANNED_TIMELINE,
      refresh: notCalled('task.refresh'),
      syncMeta: notCalled('task.syncMeta'),
    },
    next: async (_params) => CANNED_NEXT,
    evidence: {
      add: notCalled('evidence.add'),
      list: async (_params) => CANNED_EVIDENCE,
      show: notCalled('evidence.show'),
      suggest: notCalled('evidence.suggest'),
    },
    obligation: {
      list: async (_params) => CANNED_OBLIGATIONS,
      show: notCalled('obligation.show'),
      satisfy: notCalled('obligation.satisfy'),
      waive: notCalled('obligation.waive'),
      cancel: notCalled('obligation.cancel'),
    },
    transition: {
      apply: notCalled('transition.apply'),
    },
    run: {
      start: notCalled('run.start'),
      bindExternal: notCalled('run.bindExternal'),
      finish: notCalled('run.finish'),
      fail: notCalled('run.fail'),
      show: notCalled('run.show'),
      list: async (_params) => CANNED_RUNS,
    },
    effect: {
      list: async (_params) => CANNED_EFFECTS,
      show: notCalled('effect.show'),
      claim: notCalled('effect.claim'),
      ack: notCalled('effect.ack'),
      fail: notCalled('effect.fail'),
      retry: notCalled('effect.retry'),
      deliver: notCalled('effect.deliver'),
    },
  }
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('W2a: GET /v1/tasks/:taskId — wrkf projection', () => {
  // ── 1. Source-tagged response shape ────────────────────────────────────────
  //
  // RED because: current handler ignores deps.wrkf, uses withDurableWorkflowKernel.
  // kernel.getTask() clones via JSON.parse(JSON.stringify(undefined)) → SyntaxError → 500.
  // Both status (expects 200) and body assertions fail.
  //
  describe('source-tagged wrkf projection (RED: handler uses kernel, kernel.getTask throws → 500)', () => {
    test('GET returns 200 with source:"wrkf" when deps.wrkf provides data', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{ source: string }>(response)
          expect(body.source).toBe('wrkf')
        },
        { wrkf: makeFakeWrkfPort() }
      )
    })

    test('response body contains all wrkf-projected fields: task, instance, next, timeline, evidence, obligations, effects, runs', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<{
            source: string
            task: unknown
            instance: unknown
            next: unknown
            timeline: unknown
            evidence: unknown
            obligations: unknown
            effects: unknown
            runs: unknown
          }>(response)
          expect(body.source).toBe('wrkf')
          expect(body.task).toEqual(CANNED_TASK)
          expect(body.instance).toEqual(CANNED_INSTANCE)
          expect(body.next).toEqual(CANNED_NEXT)
          expect(body.timeline).toEqual(CANNED_TIMELINE)
          expect(body.evidence).toEqual(CANNED_EVIDENCE)
          expect(body.obligations).toEqual(CANNED_OBLIGATIONS)
          expect(body.effects).toEqual(CANNED_EFFECTS)
          expect(body.runs).toEqual(CANNED_RUNS)
        },
        { wrkf: makeFakeWrkfPort() }
      )
    })
  })

  // ── 2. No ACP-only fields ───────────────────────────────────────────────────
  //
  // RED because: current handler ignores deps.wrkf, kernel.getTask throws → 500.
  // Even if 200 were somehow reached, current body has supervisorRuns/participantRuns/etc.
  //
  describe('ACP-only fields removed (RED: current response is 500, body has ACP-only fields)', () => {
    test('response must not contain supervisorRuns, participantRuns, workflowHrcRunMaps, anomalies, workflowPatchProposals, or events', async () => {
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(200)
          const body = await fixture.json<Record<string, unknown>>(response)
          // Must not contain ACP kernel-only fields being removed in W2a
          expect(body['supervisorRuns']).toBeUndefined()
          expect(body['participantRuns']).toBeUndefined()
          expect(body['workflowHrcRunMaps']).toBeUndefined()
          expect(body['anomalies']).toBeUndefined()
          expect(body['workflowPatchProposals']).toBeUndefined()
          // 'events' is the kernel field; wrkf projection uses 'timeline' instead
          expect(body['events']).toBeUndefined()
        },
        { wrkf: makeFakeWrkfPort() }
      )
    })
  })

  // ── 3. WRKF_NOT_FOUND → HTTP 404 with wrkf error code ─────────────────────
  //
  // RED because: current handler uses kernel path; kernel.getTask throws SyntaxError → 500.
  // New handler must catch the wrkf WRKF_NOT_FOUND error and re-throw as 404.
  //
  describe('WRKF_NOT_FOUND error mapping (RED: kernel throws SyntaxError → 500, not 404+WRKF_NOT_FOUND)', () => {
    test('wrkf WRKF_NOT_FOUND error → HTTP 404 with error.code === "WRKF_NOT_FOUND"', async () => {
      const notFoundError = new WrkfError('WRKF_NOT_FOUND', `task not found: ${TASK_ID}`)
      await withWiredServer(
        async (fixture) => {
          const response = await fixture.request({
            method: 'GET',
            path: `/v1/tasks/${TASK_ID}`,
          })
          expect(response.status).toBe(404)
          const body = await fixture.json<{ error: { code: string; message: string } }>(response)
          // The new handler must re-throw as AcpHttpError(404, 'WRKF_NOT_FOUND', e.message)
          // Current handler returns { error: { code: 'not_found', ... } } from the kernel path
          expect(body.error.code).toBe('WRKF_NOT_FOUND')
        },
        { wrkf: makeFakeWrkfPort({ inspectError: notFoundError }) }
      )
    })
  })

  // ── 4. deps.wrkf undefined → 503 WRKF_UNAVAILABLE ──────────────────────────
  //
  // RED because: current handler ignores deps.wrkf entirely. With no wrkf injected,
  // the kernel path runs, kernel.getTask throws SyntaxError → 500. Test asserts 503.
  //
  describe('deps.wrkf undefined guard (RED: current handler ignores wrkf, kernel throws → 500 not 503)', () => {
    test('GET /v1/tasks/:taskId without deps.wrkf returns 503 with WRKF_UNAVAILABLE', async () => {
      // withWiredServer called without wrkf override → deps.wrkf is undefined
      await withWiredServer(async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/tasks/${TASK_ID}`,
        })
        expect(response.status).toBe(503)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toBe('WRKF_UNAVAILABLE')
      })
    })
  })

  // ── 5. Handler must not use withDurableWorkflowKernel ──────────────────────
  //
  // RED because: current handler calls withDurableWorkflowKernel. This source-level
  // assertion verifies the impl removed that call from handleGetWorkflowTask.
  // NOTE: other handlers (create, transitions, etc.) may still call it.
  //
  describe('handler source does not use withDurableWorkflowKernel (RED: current handler calls it)', () => {
    test('handleGetWorkflowTask function body does not contain withDurableWorkflowKernel', () => {
      const handlerSrc = readFileSync(
        new URL('../handlers/workflow-tasks.ts', import.meta.url),
        'utf-8'
      )
      // Extract just the handleGetWorkflowTask function body to be precise.
      // The export spans from "export const handleGetWorkflowTask" to the closing "}"
      // at the same nesting level. A simple heuristic: find the block starting at that
      // declaration. For the assertion, we check the full file since the function is
      // the only GET handler. After refactor, withDurableWorkflowKernel must be gone
      // from the GET handler. The import may remain if mutation handlers still use it.
      const getHandlerStart = handlerSrc.indexOf('export const handleGetWorkflowTask')
      expect(getHandlerStart).toBeGreaterThan(-1) // handler must still exist
      // Find the next export declaration after handleGetWorkflowTask to bound the search
      const nextExportStart = handlerSrc.indexOf('\nexport const handle', getHandlerStart + 1)
      const getHandlerBody =
        nextExportStart === -1
          ? handlerSrc.slice(getHandlerStart)
          : handlerSrc.slice(getHandlerStart, nextExportStart)
      // The body of handleGetWorkflowTask must not delegate to withDurableWorkflowKernel
      expect(getHandlerBody).not.toContain('withDurableWorkflowKernel')
    })
  })

  // ── 6. task.inspect transport error (JSON.parse undefined) → 404 not 500 ───
  //
  // Reproduces live bug reported by Larry: GET /v1/tasks/T-01931 where T-01931
  // exists in ACP but has no corresponding wrkf instance.
  //
  // Root cause: the real @wrkf/client throws a raw SyntaxError from JSON.parse(undefined)
  // when the wrkf process returns a response with no body for an unknown task.
  // In the W2a handler catch block, isWrkfError() does not match SyntaxError (it has no
  // .code property) → the catch block falls through to `throw error` → the ACP global
  // error handler wraps it as { error: { code: 'internal_error' } } → HTTP 500.
  //
  // Expected behavior after fix:
  //   - HTTP 404 with error.code === 'WRKF_NOT_FOUND'
  //   - No fallback to old kernel (already enforced by test 5 / handler source)
  //   - No ACP-only fields (already enforced by test 2 / handler logic)
  //
  // Fix approach (for impl agent):
  //   In handleGetWorkflowTask's catch block, before the final `throw error`, add:
  //     // Transport-level errors from task.inspect (e.g. JSON.parse(undefined) when
  //     // the wrkf process returns no body) indicate the task has no wrkf instance.
  //     // Map to WRKF_NOT_FOUND rather than leaking a raw SyntaxError → 500.
  //     throw new AcpHttpError(404, 'WRKF_NOT_FOUND', `task not found in wrkf: ${taskId}`)
  //   This is safe because task.inspect is the first call; any throw before any
  //   successful wrkf data is read means the task identity itself failed to resolve.
  //
  describe(
    'task.inspect transport error → 404 WRKF_NOT_FOUND (RED: SyntaxError escapes handler → 500 internal_error)',
    () => {
      test(
        'task.inspect throws SyntaxError (JSON.parse undefined) → HTTP 404, not 500 (live repro: T-01931 no wrkf instance)',
        async () => {
          // Simulate what @wrkf/client does when the wrkf process returns no body for a
          // task that has no wrkf instance: JSON.parse(undefined) → SyntaxError.
          const transportError = new SyntaxError(
            'Unexpected token u in JSON at position 0' // JSON.parse(undefined)
          )
          await withWiredServer(
            async (fixture) => {
              const response = await fixture.request({
                method: 'GET',
                path: `/v1/tasks/${TASK_ID}`,
              })
              // RED: isWrkfError(SyntaxError) === false (no .code) → re-thrown → 500 internal_error
              // GREEN: handler catches all errors from task.inspect as WRKF_NOT_FOUND → 404
              expect(response.status).toBe(404)
              const body = await fixture.json<{ error: { code: string; message: string } }>(
                response
              )
              expect(body.error.code).toBe('WRKF_NOT_FOUND')
            },
            { wrkf: makeFakeWrkfPort({ inspectError: transportError }) }
          )
        }
      )

      test(
        'task.inspect throws TypeError (e.g. cannot read property of undefined) → HTTP 404, not 500',
        async () => {
          // Defensive coverage: the transport layer may also produce a TypeError if it tries
          // to access a property on an undefined response object before reaching JSON.parse.
          // Both SyntaxError and TypeError are non-WrkfError throws from task.inspect that
          // must not escape as 500.
          const transportError = new TypeError(
            "Cannot read properties of undefined (reading 'data')"
          )
          await withWiredServer(
            async (fixture) => {
              const response = await fixture.request({
                method: 'GET',
                path: `/v1/tasks/${TASK_ID}`,
              })
              // RED: TypeError has no .code → isWrkfError fails → re-thrown → 500 internal_error
              // GREEN: any non-WrkfError from task.inspect maps to 404 WRKF_NOT_FOUND
              expect(response.status).toBe(404)
              const body = await fixture.json<{ error: { code: string } }>(response)
              expect(body.error.code).toBe('WRKF_NOT_FOUND')
            },
            { wrkf: makeFakeWrkfPort({ inspectError: transportError }) }
          )
        }
      )
    }
  )
})
