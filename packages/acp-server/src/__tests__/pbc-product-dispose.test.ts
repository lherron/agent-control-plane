// PBC product facade: dispose. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import {
  AGENT_ACTOR,
  BEHAVIOR_NOTE_NEXT,
  HUMAN_ACTOR,
  TASK,
  makeProductFakePort,
} from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('POST /v1/pbc/tasks/:taskId/dispose — human actor + validation (RED)', () => {
  test('[RED] HUMAN actor with valid resolution → 200 with disposed projection', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-human-001',
            resolution: 'abandoned',
            reason: 'Requirements changed completely',
          },
        })

        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
      },
      { wrkf }
    )
  })

  test('[RED] AGENT actor on /dispose → 403 (disposition is human-only)', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': AGENT_ACTOR },
          body: {
            idempotencyKey: 'dispose-agent-rejected-001',
            resolution: 'abandoned',
            reason: 'Agent tries to dispose',
          },
        })

        expect(response.status).toBe(403)
      },
      { wrkf }
    )
  })

  test('[RED] missing reason → 400 (reason is required for dispose)', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-no-reason-001',
            resolution: 'abandoned',
            // missing reason
          },
        })

        expect(response.status).toBe(400)
      },
      { wrkf }
    )
  })

  test('[RED] missing resolution → 400 (resolution is required for dispose)', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-no-resolution-001',
            reason: 'some reason but no resolution',
            // missing resolution
          },
        })

        expect(response.status).toBe(400)
      },
      { wrkf }
    )
  })

  test('[RED] dispose applies dispose_from_* transition matching current phase', async () => {
    const wrkf = makeProductFakePort({
      next: async () => BEHAVIOR_NOTE_NEXT, // phase = behavior_note
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-transition-001',
            resolution: 'abandoned',
            reason: 'Scope dropped from sprint',
          },
        })

        expect(response.status).toBe(200)

        // dispose_from_behavior_note (or similar) must be applied
        const applyCalls = wrkf._calls.filter((c) => c.method === 'transition.apply')
        expect(applyCalls.length).toBeGreaterThan(0)

        const transitionNames = applyCalls.map(
          (c) => (c.params as Record<string, unknown>)['transition']
        )
        expect(transitionNames.some((t) => String(t).startsWith('dispose_from_'))).toBe(true)
      },
      { wrkf }
    )
  })

  test('[RED] dispose adds disposition_decision evidence before applying transition', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/dispose`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'dispose-evidence-order-001',
            resolution: 'abandoned',
            reason: 'Out of scope',
          },
        })
        expect(response.status).toBe(200)

        // disposition_decision evidence must be added
        const evidenceAdds = wrkf._calls.filter((c) => c.method === 'evidence.add')
        const dispositionEv = evidenceAdds.find(
          (c) => (c.params as Record<string, unknown>)['kind'] === 'disposition_decision'
        )
        expect(dispositionEv).toBeDefined()

        // evidence.add must come BEFORE transition.apply
        const methods = wrkf._calls.map((c) => c.method)
        const evidenceIdx = methods.indexOf('evidence.add')
        const transitionIdx = methods.indexOf('transition.apply')
        expect(evidenceIdx).toBeGreaterThan(-1)
        expect(transitionIdx).toBeGreaterThan(evidenceIdx)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/dispose`,
        headers: { 'x-acp-actor': HUMAN_ACTOR },
        body: {
          idempotencyKey: 'dispose-no-wrkf',
          resolution: 'abandoned',
          reason: 'test',
        },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})
