// PBC approve-transition contract exercised through the real ACP HTTP router.
import { describe, expect, test } from 'bun:test'

import { makeFakePort, makeNextRaw } from '../../test/fixtures/pbc-harness-port.js'
import { approveTransitionRoute, postPbcRoute } from '../../test/fixtures/pbc-harness-routes.js'
import type { ApproveTransitionRequest } from './pbc-harness.js'

describe('approveTransition', () => {
  // ── Re-read next immediately before apply ──────────────────────────────────

  test('approve-transition re-reads next and applies with its revision and contextHash under wrkf wire names', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 7, contextHash: 'sha256:ctx7' })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'run_pressure_pass',
      actor: 'human:operator',
      routeKey: 'approve-rk-2',
    } satisfies ApproveTransitionRequest)

    // next is re-read before the apply (fresh CAS)
    const callMethods = port._calls.map((c) => c.method)
    expect(callMethods.indexOf('next')).toBeGreaterThan(-1)
    expect(callMethods.indexOf('transition.apply')).toBeGreaterThan(callMethods.indexOf('next'))
    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['expectRevision']).toBe(7)
    expect(params['contextHash']).toBe('sha256:ctx7')
    // wrkf wire names: task + transition, never taskId / transitionId
    expect(params['task']).toBe('T-00001')
    expect(params['taskId']).toBeUndefined()
    expect(params['transition']).toBe('run_pressure_pass')
    expect(params['transitionId']).toBeUndefined()
  })

  // ── Deterministic idempotency key ──────────────────────────────────────────

  test('idempotency key is {routeKey}:transition:{transition}:{revision}', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 3, contextHash: 'sha256:ctx3' })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'finalize_ready_pbc',
      actor: 'human:operator',
      routeKey: 'approve-rk-99',
    } satisfies ApproveTransitionRequest)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['idempotencyKey']).toBe('approve-rk-99:transition:finalize_ready_pbc:3')
  })

  // ── runChecks forwarded ────────────────────────────────────────────────────

  test('forwards runChecks=true to transition.apply when requested', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 2 })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-3',
      runChecks: true,
    } satisfies ApproveTransitionRequest)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    expect((applyCall!.params as Record<string, unknown>)['runChecks']).toBe(true)
  })

  test('defaults runChecks=false when not specified', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 1 })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-4',
    } satisfies ApproveTransitionRequest)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    // default is false
    expect(params['runChecks']).toBe(false)
  })

  // ── Effect delivery after transition ────────────────────────────────────────

  test('delivers pending effects after committed transition', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 5 })],
      effects: [
        { id: 'eff_100', kind: 'set_task_state', status: 'pending' },
        { id: 'eff_101', kind: 'set_task_state', status: 'pending' },
      ],
    })
    const result = await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'finalize_ready_pbc',
      actor: 'human:operator',
      routeKey: 'approve-rk-5',
    } satisfies ApproveTransitionRequest)

    expect(result.effectsDelivered).toHaveLength(2)
    expect(result.effectsDelivered.map((e) => (e as Record<string, unknown>)['id'])).toContain(
      'eff_100'
    )
    expect(result.effectsDelivered.map((e) => (e as Record<string, unknown>)['id'])).toContain(
      'eff_101'
    )
  })

  // ── Result model ─────────────────────────────────────────────────────────

  test('result includes latest revision+contextHash after transition', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 8, contextHash: 'sha256:ctx8' })],
    })
    const result = await approveTransitionRoute(port, {
      task: 'T-00099',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-6',
    } satisfies ApproveTransitionRequest)

    // Must include current revision (from the re-read next, which is the freshest known)
    expect(result.instance.revision).toBe(8)
    expect(result.instance.contextHash).toBe('sha256:ctx8')
    expect(result.transitionApplied).toBeDefined()
    expect(result.task).toBe('T-00099')
  })

  // ── Stale revision: single retry ───────────────────────────────────────────

  test('on WRKF_STALE_REVISION re-reads next once and retries transition', async () => {
    let applyCallCount = 0
    const port = makeFakePort({
      nextSequence: [
        makeNextRaw({ revision: 3, contextHash: 'sha256:stale' }),
        makeNextRaw({ revision: 4, contextHash: 'sha256:fresh' }),
      ],
      transitionShouldThrow: (_t) => {
        applyCallCount++
        if (applyCallCount === 1) {
          const err = new Error('WRKF_STALE_REVISION') as Error & { code: string }
          err.code = 'WRKF_STALE_REVISION'
          return err
        }
        return undefined
      },
    })
    const result = await approveTransitionRoute(port, {
      task: 'T-00001',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-stale',
    } satisfies ApproveTransitionRequest)

    // Should have retried once with fresh revision
    expect(applyCallCount).toBe(2)
    const applyCalls = port._calls.filter((c) => c.method === 'transition.apply')
    // Second apply uses the fresh revision
    const secondApplyParams = applyCalls[1]!.params as Record<string, unknown>
    expect(secondApplyParams['expectRevision']).toBe(4)
    expect(secondApplyParams['contextHash']).toBe('sha256:fresh')
    expect(result.transitionApplied).toBeDefined()
  })

  test('does NOT retry a second time on repeated WRKF_STALE_REVISION', async () => {
    let applyCallCount = 0
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 3 }), makeNextRaw({ revision: 4 })],
      transitionShouldThrow: () => {
        applyCallCount++
        const err = new Error('WRKF_STALE_REVISION') as Error & { code: string }
        err.code = 'WRKF_STALE_REVISION'
        return err
      },
    })

    const response = await postPbcRoute(port, 'approve-transition', {
      task: 'T-00001',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-stale2',
    } satisfies ApproveTransitionRequest)
    expect(response.status).toBe(409)
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('WRKF_STALE_REVISION')

    expect(applyCallCount).toBe(2) // exactly 1 retry
  })

  test('transition.apply uses `task` wire name, not `taskId`', async () => {
    const port = makeFakePort({
      nextSequence: [makeNextRaw({ revision: 0 })],
    })
    await approveTransitionRoute(port, {
      task: 'T-00088',
      transition: 'normalize_feedback',
      actor: 'human:operator',
      routeKey: 'approve-rk-7',
    } satisfies ApproveTransitionRequest)

    const applyCall = port._calls.find((c) => c.method === 'transition.apply')
    expect(applyCall).toBeDefined()
    const params = applyCall!.params as Record<string, unknown>
    expect(params['task']).toBe('T-00088')
    expect(params['taskId']).toBeUndefined()
    expect(params['transition']).toBeDefined()
    expect(params['transitionId']).toBeUndefined()
  })
})
