import { expect, test } from 'bun:test'
import { type WorkClient, WorkRpcError } from '@wrkq/client'
import { BACKFILL_PRINCIPAL, RECONCILER_DEFAULTS } from 'acp-reconciler'
import type { HrcClient } from 'hrc-sdk'
import type { JobIdentityVerification } from '../src/jobs/node-identity.js'
import { createHostedReconciler } from '../src/reconciler-request-backfill.js'
import { createWrkfClientLifecycle } from '../src/wrkf/client-lifecycle.js'

function fixture() {
  const calls: string[] = []
  let ext: { body: { rev: number }; etag: number } | undefined
  let eventCreated = false
  let losePut = false
  let loseEvent = false
  let closed = 0
  const task = {
    id: 'T-00001',
    uuid: 'uuid-1',
    etag: 1,
    state: 'completed',
    meta: { acp: { request: { rev: 2 } } },
  }
  const client = {
    close: async () => {
      closed++
    },
    wrkq: {
      task: {
        list: async (p: { state: string[] }) => {
          calls.push('list')
          return { items: p.state.includes('completed') ? [task] : [] }
        },
        show: async () => {
          calls.push('show')
          return task
        },
      },
      ext: {
        listView: async () => {
          calls.push('ext.list')
          return { items: [] }
        },
        show: async () => {
          calls.push('ext.show')
          if (!ext)
            throw new WorkRpcError({
              code: -32004,
              message: 'not found',
              data: { code: 'WRKQ_NOT_FOUND' },
            })
          return { ext }
        },
        put: async (p: { ifMatch: number; principalRef: string; body: { rev: number } }) => {
          expect(p.principalRef).toBe(BACKFILL_PRINCIPAL)
          expect(p.ifMatch).toBe(0)
          calls.push('put')
          ext = { body: p.body, etag: 1 }
          if (losePut) {
            losePut = false
            throw new Error('lost put reply')
          }
          return { ext }
        },
      },
      projectEvent: {
        post: async (p: { idempotencyKey: string; principalRef: string }) => {
          expect(p.idempotencyKey).toBe('backfill:T-00001:acp/request')
          expect(p.principalRef).toBe(BACKFILL_PRINCIPAL)
          calls.push('fact')
          const created = !eventCreated
          eventCreated = true
          if (loseEvent) {
            loseEvent = false
            throw new Error('lost event reply')
          }
          return { uuid: 'fact-1', created }
        },
      },
    },
  } as unknown as WorkClient
  const hrcClient = {
    getStatus: async () => ({ node: { nodeId: 'max3' } }),
  } as unknown as HrcClient
  const good: JobIdentityVerification = {
    ok: true,
    identity: { nodeId: 'max3', mode: 'single-node', verifiedAt: new Date().toISOString() },
  }
  return {
    calls,
    client,
    hrcClient,
    good,
    closed: () => closed,
    losePut: () => {
      losePut = true
    },
    loseEvent: () => {
      loseEvent = true
    },
  }
}

async function hosted(
  f: ReturnType<typeof fixture>,
  verifyFresh: () => Promise<JobIdentityVerification> = async () => f.good,
  principal = BACKFILL_PRINCIPAL
) {
  return createHostedReconciler({
    config: { ...RECONCILER_DEFAULTS, node: 'max3', principalRef: principal },
    lifecycle: { clientForPrincipal: async () => f.client },
    target: 'rpc://scratch',
    nodeAuthority: { verifyFresh },
    hrcClient: f.hrcClient,
  })
}

test('actual lifecycle cache supplies the same object to normal reconciler and bound maintenance', async () => {
  const f = fixture()
  const launches: string[] = []
  const lifecycle = await createWrkfClientLifecycle({
    dbLocator: 'rpc://scratch',
    _createClient: async (options) => {
      launches.push(options.principalRef ?? '')
      return f.client
    },
  })
  const host = await createHostedReconciler({
    config: { ...RECONCILER_DEFAULTS, node: 'max3' },
    lifecycle,
    target: 'rpc://scratch',
    nodeAuthority: { verifyFresh: async () => f.good },
    hrcClient: f.hrcClient,
  })
  expect(await lifecycle.clientForPrincipal(BACKFILL_PRINCIPAL)).toBe(f.client)
  await host.reconciler?.explain()
  expect(f.calls).toContain('ext.list')
  const reply = await host.requestBackfill!.plan('request-1')
  expect(reply.status).toBe(200)
  expect(reply.result).toMatchObject({ scanned: 1, rows: [{ task: 'T-00001' }] })
  expect(launches).toEqual(['agent:acp-server', BACKFILL_PRINCIPAL])
  expect(reply.receipt).toMatchObject({
    producer: BACKFILL_PRINCIPAL,
    node: 'max3',
    target: 'rpc://scratch',
    requestId: 'request-1',
    pid: process.pid,
  })
  expect(reply.receipt.consumedRevision.routineSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(f.calls).not.toContain('put')
  expect(f.calls).not.toContain('fact')
  expect(f.closed()).toBe(0)
  await lifecycle.close()
})

test('unavailable/mismatched HRC authority or configured principal refuses before owner effects', async () => {
  for (const [principal, verification] of [
    [BACKFILL_PRINCIPAL, { ok: false, code: 'hrc_identity_unavailable', message: 'unavailable' }],
    [
      BACKFILL_PRINCIPAL,
      { ok: true, identity: { nodeId: 'other', mode: 'single-node', verifiedAt: 'now' } },
    ],
    [
      'agent:other',
      { ok: true, identity: { nodeId: 'max3', mode: 'single-node', verifiedAt: 'now' } },
    ],
  ] as const) {
    const f = fixture()
    const host = await hosted(f, async () => verification, principal)
    expect((await host.requestBackfill!.plan('request')).status).toBe(503)
    expect(f.calls).toEqual([])
  }
  const f = fixture()
  const host = await createHostedReconciler({
    config: undefined,
    lifecycle: {
      clientForPrincipal: async () => {
        throw new Error('must not resolve')
      },
    },
    target: 'scratch',
    nodeAuthority: { verifyFresh: async () => f.good },
  })
  expect(host.requestBackfill).toBeUndefined()
})

test('busy refuses rather than queues, with host provenance for both outcomes', async () => {
  const f = fixture()
  let release: ((value: JobIdentityVerification) => void) | undefined
  const wait = new Promise<JobIdentityVerification>((resolve) => {
    release = resolve
  })
  const host = await hosted(f, async () => wait)
  const first = host.requestBackfill!.plan('first')
  const second = await host.requestBackfill!.plan('second')
  expect(second.status).toBe(409)
  expect(second.error?.code).toBe('backfill_busy')
  expect(f.calls).toEqual([])
  release?.(f.good)
  const reply = await first
  expect(reply.status).toBe(200)
  expect(reply.receipt.hostId).toBe(second.receipt.hostId)
})

for (const lost of ['put', 'event'] as const) {
  test(`partial ${lost} failure retains uncertain progress, same-manifest recovery and zero/zero replay`, async () => {
    const f = fixture()
    const host = await hosted(f)
    const cap = host.requestBackfill!
    const planned = await cap.plan('plan')
    const plan = planned.result as { sha256: string }
    if (lost === 'put') f.losePut()
    else f.loseEvent()
    const failure = await cap.apply(plan, plan.sha256, 'first-apply')
    expect(failure.status).toBe(502)
    expect(failure.error?.effectsUncertain).toBe(true)
    expect(failure.error?.progress).toBeDefined()
    const resume = await cap.apply(plan, plan.sha256, 'resume')
    expect(resume.status).toBe(200)
    const rerun = await cap.apply(plan, plan.sha256, 'rerun')
    expect(rerun.result).toMatchObject({ written: 0, eventsCreated: 0 })
    expect(f.calls.filter((c) => c === 'put').length).toBe(1)
    expect(f.closed()).toBe(0)
  })
}

test('wrong digest/locator refuses, preserving the original owner data', async () => {
  const f = fixture()
  const host = await hosted(f)
  const cap = host.requestBackfill!
  const plan = (await cap.plan('plan')).result as { sha256: string; target: string }
  expect((await cap.apply(plan, 'a'.repeat(64), 'bad-hash')).status).toBe(400)
  plan.target = 'rpc://foreign'
  expect((await cap.apply(plan, plan.sha256, 'bad-target')).status).toBe(400)
  expect(f.calls).not.toContain('put')
  expect(f.closed()).toBe(0)
})
