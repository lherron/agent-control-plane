/**
 * Red tests for effect-delivery.ts (Phase 4).
 *
 * Defines the contract for:
 *   deliverPbcEffects(port: PbcEffectDeliveryPort, input: EffectDeliveryInput):
 *     Promise<EffectDeliveryResult>
 *
 * where:
 *   EffectDeliveryInput = { task: string; adapter?: string; maxEffects?: number }
 *   EffectDeliveryResult = { delivered: string[]; skipped: Array<{effectId: string; reason: string}> }
 *
 * All tests FAIL until the module is implemented — that is by design (red phase).
 *
 * Contract summary (SPEC §4.14, task T-02034):
 *   - effect.list({task}) then effect.deliver({effectId, adapter:'acp'}) for EACH pending effect
 *   - effect.deliver params = {effectId, adapter} ONLY — task is NOT included (server ignores it)
 *   - NEVER calls effect.claim / effect.ack / effect.fail (no manual claim loop)
 *   - WRKF_LEASE_CONFLICT on one effect is non-fatal: skip it, continue, report in skipped
 *   - Non-WRKF_LEASE_CONFLICT errors are fatal and propagate
 *
 * Fake WrkfPort uses a `_calls` spy to assert call-order invariants.
 */

import { describe, expect, test } from 'bun:test'

// These imports define the module contract. They will fail until the module exists.
import {
  type EffectDeliveryInput,
  type EffectDeliveryResult,
  type PbcEffectDeliveryPort,
  deliverPbcEffects,
} from './effect-delivery.js'

// ---------------------------------------------------------------------------
// Fake port
// ---------------------------------------------------------------------------

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
        if (leaseConflicts.has(params.effectId)) {
          throw makeLeaseConflictError()
        }
        return { effectId: params.effectId, status: 'delivered' }
      },
    },
  }
}

// Common test fixtures
const TASK = 'T-02099'
const TWO_PENDING_EFFECTS: RawEffect[] = [
  { id: 'eff_aaa111', kind: 'set_task_state', status: 'pending' },
  { id: 'eff_bbb222', kind: 'set_task_state', status: 'pending' },
]

// ---------------------------------------------------------------------------
// Tests: call ordering — list → deliver
// ---------------------------------------------------------------------------

describe('deliverPbcEffects - call ordering', () => {
  test('calls effect.list({task}) as the very first call', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    expect(port._calls[0]?.method).toBe('effect.list')
  })

  test('calls effect.list with {task} wire name', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    const listCall = port._calls.find((c) => c.method === 'effect.list')
    expect(listCall).toBeDefined()
    const params = listCall!.params as Record<string, unknown>
    expect(params['task']).toBe(TASK)
  })

  test('calls effect.deliver for each pending effect after effect.list', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    const callMethods = port._calls.map((c) => c.method)
    const listIdx = callMethods.indexOf('effect.list')
    const firstDeliverIdx = callMethods.indexOf('effect.deliver')

    expect(listIdx).toBeGreaterThan(-1)
    expect(firstDeliverIdx).toBeGreaterThan(listIdx)
  })

  test('calls effect.deliver for each pending effect in list order', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    const deliverCalls = port._calls.filter((c) => c.method === 'effect.deliver')
    expect(deliverCalls).toHaveLength(2)
    expect((deliverCalls[0]!.params as Record<string, unknown>)['effectId']).toBe('eff_aaa111')
    expect((deliverCalls[1]!.params as Record<string, unknown>)['effectId']).toBe('eff_bbb222')
  })

  test('returns delivered effect ids in result.delivered', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    const result: EffectDeliveryResult = await deliverPbcEffects(port, input)

    expect(result.delivered).toHaveLength(2)
    expect(result.delivered).toContain('eff_aaa111')
    expect(result.delivered).toContain('eff_bbb222')
  })

  test('returns empty delivered and skipped when effect list is empty', async () => {
    const port = makeFakePort({ effects: [] })
    const input: EffectDeliveryInput = { task: TASK }

    const result: EffectDeliveryResult = await deliverPbcEffects(port, input)

    expect(result.delivered).toEqual([])
    expect(result.skipped).toEqual([])
    // effect.deliver must never be called if list returns nothing
    const deliverCalls = port._calls.filter((c) => c.method === 'effect.deliver')
    expect(deliverCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Tests: effect.deliver params shape
// ---------------------------------------------------------------------------

describe('deliverPbcEffects - deliver params shape', () => {
  test('effect.deliver receives {effectId, adapter} — task is absent', async () => {
    const port = makeFakePort({
      effects: [{ id: 'eff_ccc333', kind: 'set_task_state', status: 'pending' }],
    })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    const deliverCall = port._calls.find((c) => c.method === 'effect.deliver')
    expect(deliverCall).toBeDefined()
    const params = deliverCall!.params as Record<string, unknown>

    // effectId must be present
    expect(params['effectId']).toBe('eff_ccc333')
    // adapter must be present
    expect(typeof params['adapter']).toBe('string')
    // task MUST NOT be forwarded to effect.deliver (server ignores it; presence is an impl bug)
    expect(params['task']).toBeUndefined()
  })

  test('effect.deliver defaults to adapter="acp" when input.adapter is not specified', async () => {
    const port = makeFakePort({
      effects: [{ id: 'eff_ddd444', kind: 'set_task_state', status: 'pending' }],
    })
    const input: EffectDeliveryInput = { task: TASK } // no adapter

    await deliverPbcEffects(port, input)

    const deliverCall = port._calls.find((c) => c.method === 'effect.deliver')
    const params = deliverCall!.params as Record<string, unknown>
    expect(params['adapter']).toBe('acp')
  })

  test('effect.deliver uses input.adapter when explicitly provided', async () => {
    const port = makeFakePort({
      effects: [{ id: 'eff_eee555', kind: 'set_task_state', status: 'pending' }],
    })
    const input: EffectDeliveryInput = { task: TASK, adapter: 'custom-adapter' }

    await deliverPbcEffects(port, input)

    const deliverCall = port._calls.find((c) => c.method === 'effect.deliver')
    const params = deliverCall!.params as Record<string, unknown>
    expect(params['adapter']).toBe('custom-adapter')
  })

  test('effect.deliver params contain exactly effectId and adapter — no extra keys', async () => {
    const port = makeFakePort({
      effects: [{ id: 'eff_fff666', kind: 'set_task_state', status: 'pending' }],
    })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    const deliverCall = port._calls.find((c) => c.method === 'effect.deliver')
    const params = deliverCall!.params as Record<string, unknown>
    const keys = Object.keys(params).sort()
    expect(keys).toEqual(['adapter', 'effectId'])
  })
})

// ---------------------------------------------------------------------------
// Tests: no manual claim loop
// ---------------------------------------------------------------------------

describe('deliverPbcEffects - no manual claim loop (SPEC §4.14)', () => {
  test('does NOT call effect.claim for set_task_state effects', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    const claimCalls = port._calls.filter((c) => c.method === 'effect.claim')
    expect(claimCalls).toHaveLength(0)
  })

  test('does NOT call effect.ack', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    expect(port._calls.filter((c) => c.method === 'effect.ack')).toHaveLength(0)
  })

  test('does NOT call effect.fail', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    expect(port._calls.filter((c) => c.method === 'effect.fail')).toHaveLength(0)
  })

  test('only invokes effect.list and effect.deliver — no other effect methods', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    const unexpectedMethods = port._calls
      .map((c) => c.method)
      .filter((m) => m !== 'effect.list' && m !== 'effect.deliver')
    expect(unexpectedMethods).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Tests: WRKF_LEASE_CONFLICT is non-fatal
// ---------------------------------------------------------------------------

describe('deliverPbcEffects - WRKF_LEASE_CONFLICT handling', () => {
  test('does not throw when one effect has a lease conflict', async () => {
    const port = makeFakePort({
      effects: [
        { id: 'eff_conflict', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_ok', kind: 'set_task_state', status: 'pending' },
      ],
      leaseConflictEffectIds: ['eff_conflict'],
    })
    const input: EffectDeliveryInput = { task: TASK }

    await expect(deliverPbcEffects(port, input)).resolves.toBeDefined()
  })

  test('skipped effect is absent from result.delivered', async () => {
    const port = makeFakePort({
      effects: [
        { id: 'eff_conflict', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_ok', kind: 'set_task_state', status: 'pending' },
      ],
      leaseConflictEffectIds: ['eff_conflict'],
    })
    const input: EffectDeliveryInput = { task: TASK }

    const result: EffectDeliveryResult = await deliverPbcEffects(port, input)

    expect(result.delivered).not.toContain('eff_conflict')
    expect(result.delivered).toContain('eff_ok')
  })

  test('reports skipped effect in result.skipped with effectId and reason', async () => {
    const port = makeFakePort({
      effects: [
        { id: 'eff_conflict', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_ok', kind: 'set_task_state', status: 'pending' },
      ],
      leaseConflictEffectIds: ['eff_conflict'],
    })
    const input: EffectDeliveryInput = { task: TASK }

    const result: EffectDeliveryResult = await deliverPbcEffects(port, input)

    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.effectId).toBe('eff_conflict')
    expect(result.skipped[0]?.reason).toMatch(/lease.?conflict|WRKF_LEASE_CONFLICT/i)
  })

  test('delivered count is correct: 2 delivered, 1 skipped from 3 total', async () => {
    const port = makeFakePort({
      effects: [
        { id: 'eff_ok1', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_conflict', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_ok3', kind: 'set_task_state', status: 'pending' },
      ],
      leaseConflictEffectIds: ['eff_conflict'],
    })
    const input: EffectDeliveryInput = { task: TASK }

    const result: EffectDeliveryResult = await deliverPbcEffects(port, input)

    expect(result.delivered).toHaveLength(2)
    expect(result.delivered).toEqual(expect.arrayContaining(['eff_ok1', 'eff_ok3']))
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.effectId).toBe('eff_conflict')
  })

  test('continues delivering effects AFTER a lease conflict — non-fatal means continue', async () => {
    const port = makeFakePort({
      effects: [
        { id: 'eff_conflict_first', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_after', kind: 'set_task_state', status: 'pending' },
      ],
      leaseConflictEffectIds: ['eff_conflict_first'],
    })
    const input: EffectDeliveryInput = { task: TASK }

    await deliverPbcEffects(port, input)

    // effect.deliver must have been attempted for the second effect despite the first failing
    const deliverCalls = port._calls.filter((c) => c.method === 'effect.deliver')
    const attemptedIds = deliverCalls.map((c) => (c.params as Record<string, unknown>)['effectId'])
    expect(attemptedIds).toContain('eff_conflict_first')
    expect(attemptedIds).toContain('eff_after')
  })

  test('all-conflict case: delivered is empty, all effects reported in skipped', async () => {
    const port = makeFakePort({
      effects: [
        { id: 'eff_c1', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_c2', kind: 'set_task_state', status: 'pending' },
      ],
      leaseConflictEffectIds: ['eff_c1', 'eff_c2'],
    })
    const input: EffectDeliveryInput = { task: TASK }

    const result: EffectDeliveryResult = await deliverPbcEffects(port, input)

    expect(result.delivered).toHaveLength(0)
    expect(result.skipped).toHaveLength(2)
    const skippedIds = result.skipped.map((s) => s.effectId)
    expect(skippedIds).toContain('eff_c1')
    expect(skippedIds).toContain('eff_c2')
  })

  test('non-WRKF_LEASE_CONFLICT errors propagate — they are NOT silently swallowed', async () => {
    const fatalError = new Error('WRKF_INTERNAL: database unreachable') as Error & { code: string }
    fatalError.code = 'WRKF_INTERNAL'

    const port = makeFakePort({
      effects: [{ id: 'eff_fatal', kind: 'set_task_state', status: 'pending' }],
    })
    // Override deliver to throw an unrelated fatal error
    port.effect.deliver = async (params: { effectId: string; adapter: string }) => {
      port._calls.push({ method: 'effect.deliver', params })
      throw fatalError
    }

    await expect(deliverPbcEffects(port, { task: TASK })).rejects.toThrow(
      /WRKF_INTERNAL|database unreachable/
    )
  })
})
