// PBC product facade: projection. Historical RED labels retain original test identities.
import { describe, expect, test } from 'bun:test'

import { PBC_WORKFLOW_REF, TASK, makeProductFakePort } from '../../test/fixtures/pbc-product.js'
import { withWiredServer } from '../../test/fixtures/wired-server.js'

describe('GET /v1/pbc/tasks/:taskId — PbcTaskProjection shape (RED)', () => {
  test('[RED] returns 200 with PbcTaskProjection on successful read', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // Required top-level fields
        expect(body['source']).toBe('wrkf')
        expect(body['taskId']).toBe(TASK)
        expect(body['workflowRef']).toBe(PBC_WORKFLOW_REF)
        expect(body['instance']).toBeDefined()
        expect(typeof body['screen']).toBe('string')
        expect(Array.isArray(body['actions'])).toBe(true)
        expect(Array.isArray(body['obligations'])).toBe(true)
        expect(Array.isArray(body['effects'])).toBe(true)
        expect(body['artifacts']).toBeDefined()
        expect(body['diagnostics']).toBeDefined()
      },
      { wrkf }
    )
  })

  test('[RED] instance field has id, status, phase, revision', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const instance = body['instance'] as Record<string, unknown>

        expect(typeof instance['id']).toBe('string')
        expect(typeof instance['status']).toBe('string')
        expect(typeof instance['phase']).toBe('string')
        expect(typeof instance['revision']).toBe('number')
      },
      { wrkf }
    )
  })

  test('[RED] screen is a valid PBC screen value', async () => {
    const validScreens = [
      'starting',
      'working',
      'clarification',
      'patch_decision',
      'finalized',
      'disposed',
      'blocked',
      'error',
    ]
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        expect(validScreens).toContain(body['screen'])
      },
      { wrkf }
    )
  })

  test('[RED] diagnostics.pack is "pbc" and diagnostics.revision is a number', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)
        const diagnostics = body['diagnostics'] as Record<string, unknown>

        expect(diagnostics['pack']).toBe('pbc')
        expect(typeof diagnostics['revision']).toBe('number')
      },
      { wrkf }
    )
  })

  test('[RED] returns 503 WRKF_UNAVAILABLE when deps.wrkf is absent', async () => {
    await withWiredServer(async (fixture) => {
      const response = await fixture.request({
        method: 'GET',
        path: `/v1/pbc/tasks/${TASK}`,
      })
      expect(response.status).toBe(503)
      const body = await fixture.json<{ error: { code: string } }>(response)
      expect(body.error.code).toBe('WRKF_UNAVAILABLE')
    })
  })
})

describe('contextHash is diagnostics-only — NOT a required mutation input (RED)', () => {
  test('[RED] projection contextHash lives under instance or diagnostics, NOT at top-level', async () => {
    const wrkf = makeProductFakePort()

    await withWiredServer(
      async (fixture) => {
        const response = await fixture.request({
          method: 'GET',
          path: `/v1/pbc/tasks/${TASK}`,
        })
        expect(response.status).toBe(200)
        const body = await fixture.json<Record<string, unknown>>(response)

        // contextHash must NOT appear as a top-level field of the projection
        // (it can only appear nested under instance.contextHash or diagnostics)
        expect(body['contextHash']).toBeUndefined()

        // It is OK for contextHash to appear in instance (diagnostics only)
        // or diagnostics sub-object — that is the correct location
      },
      { wrkf }
    )
  })
})
