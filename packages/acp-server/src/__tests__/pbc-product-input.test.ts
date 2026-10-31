// PBC product facade: input. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import {
  AGENT_ACTOR,
  CLARIFICATION_NEXT,
  HUMAN_ACTOR,
  PATCH_DECISION_NEXT,
  PBC_WORKFLOW_REF,
  TASK,
  makeClarificationProductPort,
  makeProductFakePort,
} from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('POST /v1/pbc/tasks/:taskId/input — human actor + screen checks (RED)', () => {
  test('[RED] HUMAN actor with clarification_response on clarification screen → 200', async () => {
    const wrkf = makeClarificationProductPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-human-clarif-001',
            kind: 'clarification_response',
            data: { answer: 'The user double-clicks the save button' },
          },
        })

        expect(response.status).toBe(200)
      },
      { wrkf }
    )
  })

  test('[RED T-04112] missing idempotencyKey → 400 BEFORE any wrkf writes (no evidence, no transition)', async () => {
    const wrkf = makeClarificationProductPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            // idempotencyKey deliberately omitted
            kind: 'clarification_response',
            data: { answer: 'half-apply must not happen' },
          },
        })
        expect(response.status).toBe(400)

        // The half-apply is the bug: nothing may be written before the reject.
        const writeCalls = wrkf._calls.filter(
          (c) =>
            c.method === 'evidence.add' ||
            c.method === 'transition.apply' ||
            c.method === 'obligation.satisfy'
        )
        expect(writeCalls).toEqual([])
      },
      { wrkf }
    )
  })

  test('[RED] AGENT actor on /input → 403 (agent role rejected for clarification_response)', async () => {
    const wrkf = makeProductFakePort({
      next: async () => CLARIFICATION_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': AGENT_ACTOR },
          body: {
            idempotencyKey: 'input-agent-rejected-001',
            kind: 'clarification_response',
            data: { answer: 'agent tries to answer' },
          },
        })

        expect(response.status).toBe(403)
      },
      { wrkf }
    )
  })

  test('[RED] AGENT actor on /input → 403 (agent role rejected for patch_decision)', async () => {
    const wrkf = makeProductFakePort({
      next: async () => PATCH_DECISION_NEXT,
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': AGENT_ACTOR },
          body: {
            idempotencyKey: 'input-agent-patch-001',
            kind: 'patch_decision',
            data: { route: 'finalize' },
          },
        })

        expect(response.status).toBe(403)
      },
      { wrkf }
    )
  })

  test('[RED] wrong screen kind → 422 (clarification_response submitted on patch_decision screen)', async () => {
    const wrkf = makeProductFakePort({
      next: async () => PATCH_DECISION_NEXT, // screen is patch_decision
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'wrong-screen-kind-001',
            kind: 'clarification_response', // wrong: current screen is patch_decision
            data: { answer: 'wrong screen input' },
          },
        })

        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
        const body = await fixture.json<{ error: { code: string } }>(response)
        expect(body.error.code).toMatch(/WRONG_SCREEN|INVALID_KIND|SCREEN/)
      },
      { wrkf }
    )
  })

  test('[RED] wrong screen kind → 422 (patch_decision submitted on clarification screen)', async () => {
    const wrkf = makeProductFakePort({
      next: async () => CLARIFICATION_NEXT, // screen is clarification
    })

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'wrong-screen-kind-002',
            kind: 'patch_decision', // wrong: current screen is clarification
            data: { route: 'finalize' },
          },
        })

        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
      },
      { wrkf }
    )
  })

  test('[RED] /input applies answer_clarification transition on clarification screen', async () => {
    const wrkf = makeClarificationProductPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-apply-answer-001',
            kind: 'clarification_response',
            data: { answer: 'The user double-clicks the save button' },
          },
        })

        expect(response.status).toBe(200)

        // answer_clarification must be applied
        const applyCalls = wrkf._calls.filter((c) => c.method === 'transition.apply')
        expect(applyCalls.length).toBeGreaterThan(0)
        const transitionNames = applyCalls.map(
          (c) => (c.params as Record<string, unknown>)['transition']
        )
        expect(
          transitionNames.some(
            (t) => String(t).includes('answer_clarification') || String(t).includes('clarification')
          )
        ).toBe(true)
      },
      { wrkf }
    )
  })

  test('[RED] /input returns PbcTaskProjection after successful input', async () => {
    const wrkf = makeClarificationProductPort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'POST',
          path: `/v1/pbc/tasks/${TASK}/input`,
          headers: { 'x-acp-actor': HUMAN_ACTOR },
          body: {
            idempotencyKey: 'input-proj-return-001',
            kind: 'clarification_response',
            data: { answer: 'test answer' },
          },
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // Should return PbcTaskProjection
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'POST',
        path: `/v1/pbc/tasks/${TASK}/input`,
        headers: { 'x-acp-actor': HUMAN_ACTOR },
        body: {
          idempotencyKey: 'input-no-wrkf',
          kind: 'clarification_response',
          data: { answer: 'test' },
        },
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})
