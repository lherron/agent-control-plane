/**
 * AcpWrkfWorkflowPort fake-client injection via deps.wrkf + lifecycle/adapter contract.
 *
 * The workflow port is sourced from `@wrkq/client` (the unified client), adapted
 * onto the flat `AcpWrkfWorkflowPort` shape by `createWrkfClientLifecycle`. This
 * suite verifies two seams:
 *   1. The lifecycle adapter maps the flat port onto the namespaced client
 *      (`client.wrkf.*` / `client.wrkq.*`) — see "adapter contract" below.
 *   2. A fake AcpWrkfWorkflowPort injected through deps.wrkf is reachable by a
 *      route handler (GET /v1/wrkf/ping).
 */

import { describe, expect, test } from 'bun:test'
import type { WorkClient } from '@wrkq/client'

import { createWrkfClientLifecycle } from '../wrkf/client-lifecycle.js'
import type { AcpWrkfWorkflowPort } from '../wrkf/port.js'

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
      show: notCalled('workflow.show'),
      list: notCalled('workflow.list'),
      diff: notCalled('workflow.diff'),
      install: notCalled('workflow.install'),
    },
    task: {
      attach: notCalled('task.attach'),
      inspect: notCalled('task.inspect'),
      timeline: notCalled('task.timeline'),
      refresh: notCalled('task.refresh'),
      syncMeta: notCalled('task.syncMeta'),
    },
    next: notCalled('next'),
    evidence: {
      add: notCalled('evidence.add'),
      list: notCalled('evidence.list'),
      show: notCalled('evidence.show'),
      suggest: notCalled('evidence.suggest'),
    },
    obligation: {
      list: notCalled('obligation.list'),
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
      list: notCalled('run.list'),
    },
    effect: {
      list: notCalled('effect.list'),
      show: notCalled('effect.show'),
      claim: notCalled('effect.claim'),
      ack: notCalled('effect.ack'),
      fail: notCalled('effect.fail'),
      retry: notCalled('effect.retry'),
      deliver: notCalled('effect.deliver'),
    },
  }
}

describe('createWrkfClientLifecycle adapter contract (@wrkq/client → AcpWrkfWorkflowPort)', () => {
  test('maps the flat port onto the namespaced client (client.wrkf.* / client.wrkq.*)', async () => {
    const calls: Array<{ ns: string; method: string; params: unknown }> = []
    const record =
      (ns: string, method: string) =>
      (params: unknown): Promise<unknown> => {
        calls.push({ ns, method, params })
        return Promise.resolve({ ok: true })
      }

    // Minimal fake WorkClient exposing only the namespaces the adapter touches here.
    const fakeClient = {
      wrkf: {
        instance: { next: record('wrkf', 'instance.next') },
        effect: { list: record('wrkf', 'effect.list') },
      },
      wrkq: {
        workflow: { inspect: record('wrkq', 'workflow.inspect') },
      },
      call: (method: string, params: unknown): Promise<unknown> => {
        calls.push({ ns: 'call', method, params })
        return Promise.resolve({ ok: true })
      },
      close: (): Promise<void> => Promise.resolve(),
      kill: (): void => {},
    } as unknown as WorkClient

    const lifecycle = await createWrkfClientLifecycle({
      _createClient: () => Promise.resolve(fakeClient),
      dbPath: '/tmp/wrkf-adapter-test.db',
      clientInfo: { name: 'acp-server', version: '0.1.0' },
    })

    const wrkf = lifecycle.wrkf as AcpWrkfWorkflowPort

    // next → client.wrkf.instance.next
    await wrkf.next({ task: 'T-0001' })
    // task.inspect → client.wrkq.workflow.inspect
    await wrkf.task.inspect({ task: 'T-0001' })
    // effect.list → client.wrkf.effect.list
    await wrkf.effect.list({ task: 'T-0001' })
    // task.syncMeta → client.call escape hatch (T-04764)
    await wrkf.task.syncMeta({ task: 'T-0001' })

    expect(calls).toEqual([
      { ns: 'wrkf', method: 'instance.next', params: { task: 'T-0001' } },
      { ns: 'wrkq', method: 'workflow.inspect', params: { task: 'T-0001' } },
      { ns: 'wrkf', method: 'effect.list', params: { task: 'T-0001' } },
      { ns: 'call', method: 'wrkf.task.syncMeta', params: { task: 'T-0001' } },
    ])

    await lifecycle.close()
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
