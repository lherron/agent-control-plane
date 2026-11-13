import { describe, expect, test } from 'bun:test'

import { ACTOR, TASK, makeFakePbcPort } from '../../test/fixtures/pbc-route-port.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('PBC idempotency HTTP contract', () => {
  test('SAME idempotencyKey + DIFFERENT body → HTTP 409 IDEMPOTENCY_MISMATCH', async () => {
    // This is the body-hash conflict path. The idempotencyKey was already used
    // with a different request body → return 409, do NOT execute.
    const wrkf = makeFakePbcPort()

    const firstBody = {
      actor: ACTOR,
      idempotencyKey: 'idem-conflict-test-001',
      participantOutput: { evidence: [{ kind: 'result', summary: 'first output' }] },
    }
    const conflictBody = {
      actor: ACTOR,
      idempotencyKey: 'idem-conflict-test-001', // SAME key
      participantOutput: { evidence: [{ kind: 'result', summary: 'DIFFERENT output' }] }, // different body
    }

    await withWiredServer(
      async (fixture) => {
        // First request: fresh
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: firstBody,
        })
        expect(first.status).toBe(200)

        // Second request: same key + different body → conflict
        const conflict = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body: conflictBody,
        })

        expect(conflict.status).toBe(409)
        const conflictResponse = await fixture.json<{ error: { code: string } }>(conflict)
        expect(conflictResponse.error.code).toBe('IDEMPOTENCY_MISMATCH')
      },
      { wrkf }
    )
  })

  test('idempotency store is checked BEFORE harness execution (not after)', async () => {
    // The store must be consulted before any wrkf call to prevent duplicate evidence.
    // We verify this by asserting that on a replay, NO wrkf methods are called.
    const wrkf = makeFakePbcPort()

    const body = {
      actor: ACTOR,
      idempotencyKey: 'idem-order-test-001',
      participantOutput: { evidence: [{ kind: 'result', summary: 'implementation complete' }] },
    }

    await withWiredServer(
      async (fixture) => {
        // First request: executes normally
        const first = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body,
        })
        expect(first.status).toBe(200)

        const firstResult = await fixture.json<Record<string, unknown>>(first)
        const callsAfterFirst = wrkf._calls.length
        expect(wrkf._calls.filter((c) => c.method === 'evidence.add')).toHaveLength(1)

        // Second request: replay; store consulted FIRST → zero new wrkf calls
        const second = await fixture.request({
          method: 'POST',
          path: `/v1/wrkf/pbc/tasks/${TASK}/run-step`,
          body,
        })
        expect(second.status).toBe(200)

        expect(await fixture.json<Record<string, unknown>>(second)).toEqual(firstResult)
        // On replay, no additional wrkf calls should have been made
        expect(wrkf._calls.length).toBe(callsAfterFirst)
      },
      { wrkf }
    )
  })
})
