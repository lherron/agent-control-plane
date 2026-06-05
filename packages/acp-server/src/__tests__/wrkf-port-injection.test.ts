/**
 * RED TEST — AcpWrkfWorkflowPort fake-client injection via deps.wrkf (W1 acceptance gate)
 *
 * Why red: `@wrkf/client` is not installed in this workspace yet.
 * Bun throws CannotFindModule at file load; all tests below will fail.
 *
 * What larry must do to turn this green:
 *   1. Add `"@wrkf/client": "*"` to packages/acp-server/package.json dependencies
 *      and run `bun install` so the import resolves.
 *   2. Create packages/acp-server/src/wrkf/port.ts:
 *        import type { WrkfClient } from '@wrkf/client'
 *        export type AcpWrkfWorkflowPort = Pick<WrkfClient,
 *          'workflow'|'task'|'next'|'evidence'|'obligation'|'transition'|'run'|'effect'>
 *   3. Add `wrkf?: AcpWrkfWorkflowPort | undefined` to AcpServerDeps
 *      and `wrkf: AcpWrkfWorkflowPort` to ResolvedAcpServerDeps in deps.ts.
 *   4. Thread `wrkf` through resolveAcpServerDeps (must be a required resolved field,
 *      not just spread — production code should assert its presence).
 *   5. Wire a minimal test-probe route (GET /v1/wrkf/ping) that reads deps.wrkf
 *      and returns { wrkf: 'available' } so the injection is observable over HTTP.
 *      (This route may be removed after W-series testing; it must exist for W1 green.)
 */

import { describe, expect, test } from 'bun:test'

// ── RED IMPORT ──────────────────────────────────────────────────────────────
// @wrkf/client is not installed; bun throws CannotFindModule on load → RED.
// Once larry adds it to package.json + bun installs it, this resolves.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error -- @wrkf/client not yet installed (W1 step 1)
import { WrkfClient } from '@wrkf/client'
// @ts-expect-error -- wrkf/port.ts does not exist yet (W1 step 2)
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'
// ────────────────────────────────────────────────────────────────────────────

import { withWiredServer } from '../../test/fixtures/wired-server.js'

/**
 * Build a minimal fake AcpWrkfWorkflowPort for injection.
 * Each method throws if accidentally invoked — the probe route must NOT call them.
 */
function makeFakeWrkfPort(): AcpWrkfWorkflowPort {
  const notCalled = (name: string) => (): never => {
    throw new Error(`fake AcpWrkfWorkflowPort: ${name} must not be called in this test`)
  }
  return {
    workflow: {
      validate: notCalled('workflow.validate'),
      show:     notCalled('workflow.show'),
      list:     notCalled('workflow.list'),
      diff:     notCalled('workflow.diff'),
      install:  notCalled('workflow.install'),
    },
    task: {
      attach:   notCalled('task.attach'),
      inspect:  notCalled('task.inspect'),
      timeline: notCalled('task.timeline'),
      refresh:  notCalled('task.refresh'),
      syncMeta: notCalled('task.syncMeta'),
    },
    next: notCalled('next'),
    evidence: {
      add:     notCalled('evidence.add'),
      list:    notCalled('evidence.list'),
      show:    notCalled('evidence.show'),
      suggest: notCalled('evidence.suggest'),
    },
    obligation: {
      list:    notCalled('obligation.list'),
      show:    notCalled('obligation.show'),
      satisfy: notCalled('obligation.satisfy'),
      waive:   notCalled('obligation.waive'),
      cancel:  notCalled('obligation.cancel'),
    },
    transition: {
      apply: notCalled('transition.apply'),
    },
    run: {
      start:        notCalled('run.start'),
      bindExternal: notCalled('run.bindExternal'),
      finish:       notCalled('run.finish'),
      fail:         notCalled('run.fail'),
      show:         notCalled('run.show'),
      list:         notCalled('run.list'),
    },
    effect: {
      list:    notCalled('effect.list'),
      show:    notCalled('effect.show'),
      claim:   notCalled('effect.claim'),
      ack:     notCalled('effect.ack'),
      fail:    notCalled('effect.fail'),
      retry:   notCalled('effect.retry'),
      deliver: notCalled('effect.deliver'),
    },
  }
}

describe('@wrkf/client package surface', () => {
  test('WrkfClient.spawn is a function (package import works)', () => {
    // Verifies @wrkf/client is importable after larry adds the dep.
    // This test is the first to fail when the package is not installed.
    expect(typeof WrkfClient.spawn).toBe('function')
  })
})

describe('AcpWrkfWorkflowPort injection via deps.wrkf', () => {
  test('fake port injected through deps.wrkf is accessible to a route handler (GET /v1/wrkf/ping)', async () => {
    const fakePort = makeFakeWrkfPort()

    await withWiredServer(
      async (fixture) => {
        // GET /v1/wrkf/ping is a diagnostic probe route larry must add in W1.
        // The route reads deps.wrkf and returns { wrkf: 'available' }
        // when the port is present, confirming injection is wired end-to-end.
        //
        // Until the route exists: response is 404 → assertion fails → RED.
        // Until deps.wrkf is typed + threaded: the route cannot read it → RED.
        const response = await fixture.request({ method: 'GET', path: '/v1/wrkf/ping' })
        expect(response.status).toBe(200)
        const body = await fixture.json<{ wrkf: string }>(response)
        expect(body.wrkf).toBe('available')
      },
      // @ts-expect-error: deps.wrkf does not yet exist on AcpServerDeps (W1 step 3)
      { wrkf: fakePort }
    )
  })

  test('server created without deps.wrkf propagates undefined for wrkf (no injection)', async () => {
    await withWiredServer(async (fixture) => {
      // When no wrkf is injected, the probe should still return a clear status.
      const response = await fixture.request({ method: 'GET', path: '/v1/wrkf/ping' })
      // Route must return 200 even when deps.wrkf is absent; body.wrkf signals the state.
      expect(response.status).toBe(200)
      const body = await fixture.json<{ wrkf: string }>(response)
      expect(body.wrkf).toBe('unavailable')
    })
  })
})
