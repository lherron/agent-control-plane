/**
 * Red tests — Phase 1, Deliverable 4:
 * deliverWrkfEffects (renamed from deliverWrkfEffects) preserves behavior.
 *
 * WHY RED NOW:
 *   `deliverWrkfEffects` is not exported from effect-delivery.ts.
 *   The current export is `deliverWrkfEffects`.
 *   Importing `deliverWrkfEffects` produces `undefined` at runtime,
 *   causing all tests that call it to fail with TypeError: deliverWrkfEffects is not a function.
 *
 * WHAT THE IMPL AGENT MUST CHANGE in src/wrkf/effect-delivery.ts:
 *   1. Export `deliverWrkfEffects` as the canonical name:
 *        export async function deliverWrkfEffects(
 *          port: PbcEffectDeliveryPort,
 *          input: EffectDeliveryInput
 *        ): Promise<EffectDeliveryResult> { ... }
 *      OR via aliased re-export:
 *        export { deliverWrkfEffects as deliverWrkfEffects }
 *
 *   2. Update ALL call sites that use `deliverWrkfEffects` to use `deliverWrkfEffects`:
 *      - src/wrkf/pbc-harness.ts (if it imports deliverWrkfEffects)
 *      - src/handlers/wrkf-pbc-deliver-effects.ts (if it imports deliverWrkfEffects)
 *      - Any other files — verify with: rg 'deliverWrkfEffects' packages/
 *
 *   3. Keep `deliverWrkfEffects` as a deprecated alias (optional) OR remove it.
 *      The acceptance criterion is: `rg deliverWrkfEffects packages/` returns nothing
 *      (rename complete), so the old name should NOT be exported after the rename.
 *
 * Note: the existing effect-delivery.test.ts tests import `deliverWrkfEffects` and
 * will also need to be updated by the impl agent to import `deliverWrkfEffects`.
 * These red tests document the new contract for the renamed function.
 *
 * Fake port pattern matches effect-delivery.test.ts for consistency.
 */

import { describe, expect, test } from 'bun:test'

// These imports define the module contract.
// RED: deliverWrkfEffects is not exported — it resolves to undefined at runtime.
import {
  type EffectDeliveryInput,
  type EffectDeliveryResult,
  type PbcEffectDeliveryPort,
  deliverWrkfEffects,
} from './effect-delivery.js'

// ── Fake port ─────────────────────────────────────────────────────────────────

type SpyCall = { method: string; params: unknown }
type FakeEffectPort = PbcEffectDeliveryPort & { _calls: SpyCall[] }

interface RawEffect {
  id: string
  kind: string
  status: string
}

function makeLeaseConflictError(): Error & { code: string } {
  const err = new Error('WRKF_LEASE_CONFLICT: effect lease already held') as Error & { code: string }
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

const TASK = 'T-P1D4-001'
const TWO_PENDING_EFFECTS: RawEffect[] = [
  { id: 'eff_aaa111', kind: 'set_task_state', status: 'pending' },
  { id: 'eff_bbb222', kind: 'set_task_state', status: 'pending' },
]

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  1. deliverWrkfEffects is exported and callable                             ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D4: deliverWrkfEffects is exported from effect-delivery', () => {
  // RED: deliverWrkfEffects is undefined → TypeError when called

  test('deliverWrkfEffects is a function (exported from effect-delivery.ts)', () => {
    // RED: currently undefined
    expect(typeof deliverWrkfEffects).toBe('function')
  })

  test('deliverWrkfEffects returns a Promise', async () => {
    const port = makeFakePort({ effects: [] })
    const input: EffectDeliveryInput = { task: TASK }
    // RED: TypeError: deliverWrkfEffects is not a function
    const result = deliverWrkfEffects(port, input)
    expect(result).toBeInstanceOf(Promise)
    await result
  })
})

// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  2. deliverWrkfEffects preserves behavior of deliverWrkfEffects              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

describe('P1-D4: deliverWrkfEffects — call ordering preserved', () => {
  test('calls effect.list({task}) as the very first call', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    // RED: TypeError
    await deliverWrkfEffects(port, input)

    expect(port._calls[0]?.method).toBe('effect.list')
  })

  test('calls effect.deliver for each pending effect after effect.list', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    // RED: TypeError
    await deliverWrkfEffects(port, input)

    const callMethods = port._calls.map((c) => c.method)
    const listIdx = callMethods.indexOf('effect.list')
    const firstDeliverIdx = callMethods.indexOf('effect.deliver')

    expect(listIdx).toBeGreaterThan(-1)
    expect(firstDeliverIdx).toBeGreaterThan(listIdx)
  })

  test('returns delivered effect ids in result.delivered', async () => {
    const port = makeFakePort({ effects: TWO_PENDING_EFFECTS })
    const input: EffectDeliveryInput = { task: TASK }

    // RED: TypeError
    const result: EffectDeliveryResult = await deliverWrkfEffects(port, input)

    expect(result.delivered).toHaveLength(2)
    expect(result.delivered).toContain('eff_aaa111')
    expect(result.delivered).toContain('eff_bbb222')
  })

  test('returns empty delivered and skipped when effect list is empty', async () => {
    const port = makeFakePort({ effects: [] })
    const input: EffectDeliveryInput = { task: TASK }

    // RED: TypeError
    const result: EffectDeliveryResult = await deliverWrkfEffects(port, input)

    expect(result.delivered).toEqual([])
    expect(result.skipped).toEqual([])
  })
})

describe('P1-D4: deliverWrkfEffects — deliver params shape preserved', () => {
  test('effect.deliver receives {effectId, adapter} — task is absent', async () => {
    const port = makeFakePort({
      effects: [{ id: 'eff_ccc333', kind: 'set_task_state', status: 'pending' }],
    })
    const input: EffectDeliveryInput = { task: TASK }

    // RED: TypeError
    await deliverWrkfEffects(port, input)

    const deliverCall = port._calls.find((c) => c.method === 'effect.deliver')
    expect(deliverCall).toBeDefined()
    const params = deliverCall!.params as Record<string, unknown>
    expect(params['effectId']).toBe('eff_ccc333')
    expect(typeof params['adapter']).toBe('string')
    expect(params['task']).toBeUndefined()
  })

  test('defaults to adapter="acp" when input.adapter is not specified', async () => {
    const port = makeFakePort({
      effects: [{ id: 'eff_ddd444', kind: 'set_task_state', status: 'pending' }],
    })

    // RED: TypeError
    await deliverWrkfEffects(port, { task: TASK })

    const deliverCall = port._calls.find((c) => c.method === 'effect.deliver')
    expect((deliverCall!.params as Record<string, unknown>)['adapter']).toBe('acp')
  })
})

describe('P1-D4: deliverWrkfEffects — WRKF_LEASE_CONFLICT handling preserved', () => {
  test('does not throw when one effect has a lease conflict', async () => {
    const port = makeFakePort({
      effects: [
        { id: 'eff_conflict', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_ok', kind: 'set_task_state', status: 'pending' },
      ],
      leaseConflictEffectIds: ['eff_conflict'],
    })

    // RED: TypeError
    await expect(deliverWrkfEffects(port, { task: TASK })).resolves.toBeDefined()
  })

  test('reports skipped effect in result.skipped with effectId and reason', async () => {
    const port = makeFakePort({
      effects: [
        { id: 'eff_conflict', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_ok', kind: 'set_task_state', status: 'pending' },
      ],
      leaseConflictEffectIds: ['eff_conflict'],
    })

    // RED: TypeError
    const result: EffectDeliveryResult = await deliverWrkfEffects(port, { task: TASK })

    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.effectId).toBe('eff_conflict')
    expect(result.skipped[0]?.reason).toMatch(/lease.?conflict|WRKF_LEASE_CONFLICT/i)
    expect(result.delivered).toContain('eff_ok')
  })

  test('non-WRKF_LEASE_CONFLICT errors propagate — not silently swallowed', async () => {
    const fatalError = new Error('WRKF_INTERNAL: database unreachable') as Error & { code: string }
    fatalError.code = 'WRKF_INTERNAL'

    const port = makeFakePort({
      effects: [{ id: 'eff_fatal', kind: 'set_task_state', status: 'pending' }],
    })
    port.effect.deliver = async (params: { effectId: string; adapter: string }) => {
      port._calls.push({ method: 'effect.deliver', params })
      throw fatalError
    }

    // RED: TypeError (deliverWrkfEffects is not a function)
    await expect(deliverWrkfEffects(port, { task: TASK })).rejects.toThrow(
      /WRKF_INTERNAL|database unreachable/
    )
  })
})
