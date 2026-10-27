/**
 * POST /v1/wrkf/effects/deliver — effect delivery through the HTTP route.
 *
 * Contract (SPEC §4.14, task T-02034):
 *   - effect.list({task}) then effect.deliver({effectId, adapter}) for EACH pending effect,
 *     in list order; adapter defaults to 'acp'; task is NOT forwarded to deliver
 *   - WRKF_LEASE_CONFLICT on one effect is non-fatal: skip it, continue, report it in skipped
 *   - any other wrkf error fails the request (mapped status + code), never a 200
 *
 * The fake port records the outbound wrkf effect RPCs (the external wrkf boundary).
 */

import { describe, expect, test } from 'bun:test'

import { withWiredServer } from '../../test/fixtures/wired-server.js'
import type { PbcEffectDeliveryPort } from './effect-delivery.js'
import type { AcpWrkfWorkflowPort } from './port.js'

type SpyCall = { method: string; params: unknown }

type FakeEffectPort = PbcEffectDeliveryPort & { _calls: SpyCall[] }

/** Raw effect shape as returned by wrkf effect.list RPC. */
interface RawEffect {
  id: string
  kind: string
  status: string
}

/** Build a WRKF_LEASE_CONFLICT error matching the wrkf client convention. */
function makeLeaseConflictError(): Error & { code: string } {
  const err = new Error('WRKF_LEASE_CONFLICT: effect lease already held') as Error & {
    code: string
  }
  err.code = 'WRKF_LEASE_CONFLICT'
  return err
}

function makeFakePort(
  opts: {
    effects?: RawEffect[]
    leaseConflictEffectIds?: string[]
    deliverError?: Error
  } = {}
): FakeEffectPort {
  const _calls: SpyCall[] = []
  const effects: RawEffect[] = opts.effects ?? []
  const leaseConflicts = new Set(opts.leaseConflictEffectIds ?? [])

  return {
    _calls,
    effect: {
      list: async (params: { task: string }) => {
        _calls.push({ method: 'effect.list', params })
        return effects
      },
      deliver: async (params: { effectId: string; adapter: string }) => {
        _calls.push({ method: 'effect.deliver', params })
        if (opts.deliverError !== undefined) {
          throw opts.deliverError
        }
        if (leaseConflicts.has(params.effectId)) {
          throw makeLeaseConflictError()
        }
        return { effectId: params.effectId, status: 'delivered' }
      },
    },
  }
}

async function postDeliver(
  port: FakeEffectPort,
  body: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  return withWiredServer(
    async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: '/v1/wrkf/effects/deliver',
        body,
      })
      return {
        status: response.status,
        body: await fixture.json<Record<string, unknown>>(response),
      }
    },
    { wrkf: port as unknown as AcpWrkfWorkflowPort }
  )
}

const TASK = 'T-02099'
const pending = (id: string): RawEffect => ({ id, kind: 'set_task_state', status: 'pending' })

describe('POST /v1/wrkf/effects/deliver — call ordering', () => {
  test('pending effects are delivered one by one in list order', async () => {
    const port = makeFakePort({ effects: [pending('eff_aaa111'), pending('eff_bbb222')] })

    const { status } = await postDeliver(port, { task: TASK })

    expect(status).toBe(200)
    expect(port._calls).toEqual([
      { method: 'effect.list', params: { task: TASK } },
      { method: 'effect.deliver', params: { effectId: 'eff_aaa111', adapter: 'acp' } },
      { method: 'effect.deliver', params: { effectId: 'eff_bbb222', adapter: 'acp' } },
    ])
  })

  test.each([
    {
      name: 'two pending effects -> both reported delivered',
      effects: [pending('eff_aaa111'), pending('eff_bbb222')],
      delivered: ['eff_aaa111', 'eff_bbb222'],
      deliverCalls: 2,
    },
    {
      name: 'empty effect list -> nothing delivered, nothing skipped',
      effects: [],
      delivered: [],
      deliverCalls: 0,
    },
  ])(
    'response reports delivered effect ids: $name',
    async ({ effects, delivered, deliverCalls }) => {
      const port = makeFakePort({ effects })

      const result = await postDeliver(port, { task: TASK })

      expect(result.status).toBe(200)
      expect(result.body).toEqual({ task: TASK, delivered, skipped: [] })
      expect(port._calls.filter((c) => c.method === 'effect.deliver')).toHaveLength(deliverCalls)
    }
  )
})

describe('POST /v1/wrkf/effects/deliver — deliver params shape', () => {
  test.each([
    { name: 'no adapter in the request defaults to acp', body: { task: TASK }, adapter: 'acp' },
    {
      name: 'an explicit adapter is passed through',
      body: { task: TASK, adapter: 'custom-adapter' },
      adapter: 'custom-adapter',
    },
  ])('effect.deliver receives exactly {effectId, adapter}: $name', async ({ body, adapter }) => {
    const port = makeFakePort({ effects: [pending('eff_x')] })

    await postDeliver(port, body)

    const deliverCalls = port._calls.filter((c) => c.method === 'effect.deliver')
    expect(deliverCalls).toEqual([
      { method: 'effect.deliver', params: { effectId: 'eff_x', adapter } },
    ])
  })
})

describe('POST /v1/wrkf/effects/deliver — WRKF_LEASE_CONFLICT handling', () => {
  test.each([
    {
      name: 'middle effect conflicts -> it is skipped and the rest are still delivered',
      effects: [pending('eff_ok1'), pending('eff_conflict'), pending('eff_ok3')],
      conflicts: ['eff_conflict'],
      delivered: ['eff_ok1', 'eff_ok3'],
      skipped: [{ effectId: 'eff_conflict', reason: 'WRKF_LEASE_CONFLICT' }],
    },
    {
      name: 'every effect conflicts -> nothing delivered, all skipped',
      effects: [pending('eff_c1'), pending('eff_c2')],
      conflicts: ['eff_c1', 'eff_c2'],
      delivered: [],
      skipped: [
        { effectId: 'eff_c1', reason: 'WRKF_LEASE_CONFLICT' },
        { effectId: 'eff_c2', reason: 'WRKF_LEASE_CONFLICT' },
      ],
    },
  ])(
    'a lease conflict skips that effect with its reason: $name',
    async ({ effects, conflicts, delivered, skipped }) => {
      const port = makeFakePort({ effects, leaseConflictEffectIds: conflicts })

      const result = await postDeliver(port, { task: TASK })

      expect(result.status).toBe(200)
      expect(result.body).toEqual({ task: TASK, delivered, skipped })
      expect(
        port._calls
          .filter((c) => c.method === 'effect.deliver')
          .map((c) => (c.params as { effectId: string }).effectId)
      ).toEqual(effects.map((effect) => effect.id))
    }
  )

  test('a non-lease wrkf error on effect.deliver fails the request with its mapped code, not 200', async () => {
    const fatalError = new Error('WRKF_INTERNAL: database unreachable') as Error & { code: string }
    fatalError.code = 'WRKF_INTERNAL'
    const port = makeFakePort({ effects: [pending('eff_fatal')], deliverError: fatalError })

    const result = await postDeliver(port, { task: TASK })

    expect(result.status).toBe(500)
    expect(result.body['error']).toMatchObject({
      code: 'WRKF_INTERNAL',
      message: 'WRKF_INTERNAL: database unreachable',
    })
  })
})
